import {
  BaseFormatConverter,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  isCardElement,
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type Author,
  type CardElement,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  type RawMessage,
  type ThreadInfo,
  type UserInfo,
} from "chat";
import { decode as decodeNip19 } from "nostr-tools/nip19";
import type { Filter } from "nostr-tools/filter";
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { RelayClient } from "./relay.ts";
import { formatCardMessage, parseAction, type Card, type CardAction } from "./wire.ts";

export { RelayClient, RelayError } from "./relay.ts";
export { connectStdioHost, StdioHost } from "./stdio.ts";
export { formatAction, formatCardMessage, parseAction, parseCardMessage } from "./wire.ts";

const NAME = "buzz";
const KIND_MESSAGE = 9;
const KIND_EDIT = 40003;
const KIND_DELETE = 9005;
const KIND_REACTION = 7;
const KIND_TYPING = 20002;
const KIND_PROFILE = 0;
const KIND_JOIN_REQUEST = 9021;
const KIND_CHANNEL_METADATA = 39000;
const KIND_CHANNEL_MEMBERS = 39002;
const KIND_MEMBER_ADDED = 44100;
const KIND_MEMBER_REMOVED = 44101;
const MAX_CONTENT = 64 * 1024;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;
const PROFILE_TTL_MS = 10 * 60_000;

export type BuzzThreadId = { channelId: string; rootId?: string };

/** An unsigned event for the host to sign as the agent. */
export type BuzzEventTemplate = { kind: number; content: string; tags: string[][] };

/**
 * Buzz itself, when Buzz runs the bot as one of its agents (Buzz 1.x). Buzz holds
 * the agent's key and its community sign-in, signs and publishes what the bot
 * sends and reads as the agent, and delivers the messages that mention it.
 */
export interface BuzzHost {
  readonly pubkey: string;
  /** The agent's owner. */
  readonly owner?: string;
  publish(template: BuzzEventTemplate): Promise<Event>;
  query(filters: Filter[]): Promise<Event[]>;
  /** Calls `listener` with each message Buzz delivers to the agent. */
  onEvent(listener: (event: Event) => void): void;
  close?(): void;
}

export type BuzzAdapterConfig = {
  /** The community's relay, such as `wss://buzz.example.com`. Env: `BUZZ_RELAY_URL`. */
  relayUrl?: string;
  /** The bot's secret key, as 64 hex characters or `nsec1…`. Env: `BUZZ_PRIVATE_KEY`, as Buzz names it. */
  secretKey?: string;
  /**
   * Channel ids to listen in. Env: `BUZZ_CHANNELS`, comma-separated. Leave empty to
   * follow the bot's channel memberships, as Buzz agents do.
   */
  channels?: string[];
  /** The bot's NIP-OA `auth` tag from its owner, sent with AUTH. Env: `BUZZ_AUTH_TAG` (JSON array). */
  authTag?: string[];
  /** The name people use to mention the bot. Defaults to `bot`. */
  userName?: string;
  /**
   * Publishes the bot's profile (kind 0) on start, with its `auth` tag so Buzz
   * shows it as its owner's agent. Leave out to keep the profile as it is.
   */
  profile?: { name?: string; about?: string; picture?: string };
  /** Channel ids the bot joins on start (kind 9021) if it isn't a member yet. Env: `BUZZ_JOIN`, comma-separated. */
  join?: string[];
  /** Overrides the relay client, for tests. */
  relay?: RelayClient;
  /** Runs inside Buzz as one of its agents. Replaces relayUrl, secretKey, authTag, channels and join. */
  host?: BuzzHost;
};

class BuzzFormatConverter extends BaseFormatConverter {
  // Buzz messages are GitHub-flavored Markdown, the same as Chat SDK's AST.
  fromAst(ast: FormattedContent): string {
    return stringifyMarkdown(ast).trim();
  }
  toAst(text: string): FormattedContent {
    return parseMarkdown(text);
  }
}

export class BuzzAdapter implements Adapter<BuzzThreadId, Event> {
  readonly name = NAME;
  readonly userName: string;
  readonly botUserId: string;
  /** The owner named by the NIP-OA tag, if any. */
  readonly ownerPubkey: string | undefined;
  private readonly secretKey: Uint8Array | null;
  private readonly host: BuzzHost | null;
  private readonly fixedChannels: string[];
  private readonly join: string[];
  private readonly authTag: string[] | undefined;
  private readonly profile: BuzzAdapterConfig["profile"];
  private readonly channels = new Set<string>();
  private readonly relay: RelayClient | null;
  private readonly converter = new BuzzFormatConverter();
  private readonly ownMessages = new Map<string, string>();
  private readonly profiles = new Map<string, { info: UserInfo; at: number }>();
  private chat: ChatInstance | null = null;
  private logger: Logger | null = null;

  constructor(config: BuzzAdapterConfig = {}) {
    this.userName = config.userName ?? "bot";
    this.profile = config.profile;
    if (config.host) {
      this.host = config.host;
      this.secretKey = null;
      this.relay = null;
      this.botUserId = config.host.pubkey;
      this.ownerPubkey = config.host.owner;
      this.fixedChannels = [];
      this.join = [];
      this.authTag = undefined;
      return;
    }
    this.host = null;
    const relayUrl = config.relayUrl ?? process.env.BUZZ_RELAY_URL;
    const secret = config.secretKey ?? process.env.BUZZ_PRIVATE_KEY;
    const channels = config.channels ?? process.env.BUZZ_CHANNELS?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
    const authTag = config.authTag ?? (process.env.BUZZ_AUTH_TAG ? (JSON.parse(process.env.BUZZ_AUTH_TAG) as string[]) : undefined);
    if (!relayUrl) throw new Error("Buzz adapter: set relayUrl or BUZZ_RELAY_URL.");
    if (!secret) throw new Error("Buzz adapter: set secretKey or BUZZ_PRIVATE_KEY.");
    const join = config.join ?? process.env.BUZZ_JOIN?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
    for (const channel of [...channels, ...join]) if (!CHANNEL_ID.test(channel)) throw new Error(`Buzz adapter: invalid channel id ${channel}.`);
    if (authTag && (authTag.length !== 4 || authTag[0] !== "auth")) throw new Error('Buzz adapter: authTag must be ["auth", owner, conditions, signature].');

    this.secretKey = readSecretKey(secret);
    this.botUserId = getPublicKey(this.secretKey);
    this.fixedChannels = channels;
    this.join = join;
    this.authTag = authTag;
    this.ownerPubkey = authTag?.[1];
    this.relay = config.relay ?? new RelayClient({ url: relayUrl, sign: (t) => this.sign(t), ...(authTag ? { authTags: [authTag] } : {}) });
  }

  // --- lifecycle -----------------------------------------------------------

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(NAME);
    if (this.host) {
      // Buzz delivers what mentions the agent, in whichever channel.
      this.host.onEvent((event) => this.receive(event));
      this.logger.info(`Running as Buzz agent ${this.botUserId}`);
      return;
    }
    await this.relay!.connect();
    if (this.profile) await this.publishProfile(this.profile);
    if (this.fixedChannels.length) {
      for (const channel of this.fixedChannels) this.watch(channel);
    } else {
      // Membership snapshots name the channels the bot is in; notifications keep the set current.
      const snapshots = await this.relay!.query([{ kinds: [KIND_CHANNEL_MEMBERS], "#p": [this.botUserId] }]);
      for (const snapshot of snapshots) {
        const channel = tagValue(snapshot, "d");
        if (channel) this.watch(channel);
      }
      for (const channel of this.join) {
        if (this.channels.has(channel)) continue;
        await this.publish({ kind: KIND_JOIN_REQUEST, content: "", tags: [["h", channel]] });
        this.logger.info(`Joined Buzz channel ${channel}`);
        this.watch(channel);
      }
      this.relay!.subscribe("buzz-membership", [{ kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED], "#p": [this.botUserId], since: now() }], (event) => {
        const channel = tagValue(event, "h");
        if (!channel) return;
        if (event.kind === KIND_MEMBER_ADDED) this.watch(channel);
        else this.unwatch(channel);
      });
    }
    this.logger.info(`Listening in ${this.channels.size} Buzz channel(s) as ${this.botUserId}`);
  }

  /** Channels the bot can see, with whether it's a member. Needs a connected relay. */
  async listChannels(): Promise<{ id: string; name: string; member: boolean }[]> {
    const [metadata, memberships] = await Promise.all([
      this.query([{ kinds: [KIND_CHANNEL_METADATA] }]),
      this.query([{ kinds: [KIND_CHANNEL_MEMBERS], "#p": [this.botUserId] }]),
    ]);
    const mine = new Set(memberships.map((e) => tagValue(e, "d")));
    const byId = new Map<string, { id: string; name: string; member: boolean }>();
    for (const event of metadata.sort((a, b) => a.created_at - b.created_at)) {
      const id = tagValue(event, "d");
      if (id && CHANNEL_ID.test(id)) byId.set(id, { id, name: tagValue(event, "name") ?? id, member: mine.has(id) });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Connects without a Chat instance, for tools that only list channels. */
  async connect(): Promise<void> {
    await this.relay?.connect();
  }

  private async publishProfile(profile: NonNullable<BuzzAdapterConfig["profile"]>): Promise<void> {
    const name = profile.name ?? this.userName;
    const content = JSON.stringify({ name, display_name: name, ...(profile.about ? { about: profile.about } : {}), ...(profile.picture ? { picture: profile.picture } : {}), bot: true });
    await this.publish({ kind: KIND_PROFILE, content, tags: this.authTag ? [this.authTag] : [] });
  }

  /** The channels the bot listens in right now. */
  get listening(): string[] {
    return [...this.channels];
  }

  private watch(channel: string): void {
    if (!CHANNEL_ID.test(channel) || this.channels.has(channel)) return;
    this.channels.add(channel);
    this.relay!.subscribe(`ch:${channel}`, [{ kinds: [KIND_MESSAGE], "#h": [channel], since: now() }], (event) => this.receive(event));
    this.logger?.debug(`Listening in Buzz channel ${channel}`);
  }

  private unwatch(channel: string): void {
    if (!this.channels.delete(channel)) return;
    this.relay!.unsubscribe(`ch:${channel}`);
    this.logger?.debug(`Stopped listening in Buzz channel ${channel}`);
  }

  async disconnect(): Promise<void> {
    this.relay?.close();
    this.host?.close?.();
  }

  async handleWebhook(): Promise<Response> {
    return new Response("The Buzz adapter receives events over its relay connection, not webhooks.", { status: 404 });
  }

  // --- thread ids ----------------------------------------------------------

  encodeThreadId({ channelId, rootId }: BuzzThreadId): string {
    return rootId ? `${NAME}:${channelId}:${rootId}` : `${NAME}:${channelId}`;
  }

  decodeThreadId(threadId: string): BuzzThreadId {
    const [prefix, channelId, rootId, ...rest] = threadId.split(":");
    if (prefix !== NAME || !channelId || !CHANNEL_ID.test(channelId) || rest.length || (rootId !== undefined && !EVENT_ID.test(rootId)))
      throw new Error(`Invalid Buzz thread id: ${threadId}`);
    return rootId ? { channelId, rootId } : { channelId };
  }

  channelIdFromThreadId(threadId: string): string {
    return `${NAME}:${this.decodeThreadId(threadId).channelId}`;
  }

  isDM(): boolean {
    return false;
  }

  // --- inbound -------------------------------------------------------------

  private receive(event: Event): void {
    if (!this.chat || event.pubkey === this.botUserId || event.kind !== KIND_MESSAGE) return;
    const channelId = tagValue(event, "h");
    if (!channelId || !CHANNEL_ID.test(channelId) || (!this.host && !this.channels.has(channelId))) return;
    const threadId = this.encodeThreadId({ channelId, rootId: threadRoot(event) ?? event.id });
    const action = parseAction(event.content);
    if (action) {
      void this.receiveAction(event, action, channelId, threadId).catch((error: unknown) => this.logger?.error("Buzz card action failed", error));
      return;
    }
    void this.chat.processMessage(this, threadId, () => this.toMessage(event, threadId));
  }

  // A choice is an ordinary message signed by the person who made it. Accept it
  // only for a card this bot posted in the same channel.
  private async receiveAction(event: Event, action: CardAction, channelId: string, threadId: string): Promise<void> {
    if (!EVENT_ID.test(action.message)) return;
    let cardChannel = this.ownMessages.get(action.message);
    if (!cardChannel) {
      const [card] = await this.query([{ ids: [action.message], authors: [this.botUserId], limit: 1 }]);
      cardChannel = card ? tagValue(card, "h") : undefined;
    }
    if (cardChannel !== channelId) {
      this.logger?.warn(`Ignoring a card action for message ${action.message}, which this bot didn't post in this channel`);
      return;
    }
    await this.chat!.processAction(
      {
        adapter: this,
        actionId: action.action,
        messageId: action.message,
        threadId,
        user: await this.author(event.pubkey),
        raw: event,
        ...(action.value === undefined ? {} : { value: action.value }),
        ...(action.values === undefined ? {} : { values: action.values }),
      },
      undefined,
    );
  }

  parseMessage(raw: Event): Message<Event> {
    const channelId = tagValue(raw, "h") ?? "";
    const threadId = this.encodeThreadId({ channelId, rootId: threadRoot(raw) ?? raw.id });
    return this.buildMessage(raw, threadId, this.fallbackAuthor(raw.pubkey));
  }

  private async toMessage(event: Event, threadId: string): Promise<Message<Event>> {
    return this.buildMessage(event, threadId, await this.author(event.pubkey));
  }

  private buildMessage(event: Event, threadId: string, author: Author, edit?: Event): Message<Event> {
    const content = edit?.content ?? event.content;
    const { text, formatted } = this.converter.parseIncoming(content);
    return new Message({
      id: event.id,
      threadId,
      text,
      formatted,
      raw: event,
      author,
      isMention: event.tags.some((t) => t[0] === "p" && t[1] === this.botUserId),
      metadata: {
        dateSent: new Date(sentAt(event)),
        edited: !!edit,
        ...(edit ? { editedAt: new Date(edit.created_at * 1000) } : {}),
      },
      attachments: [],
    });
  }

  // --- outbound ------------------------------------------------------------

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<Event>> {
    const { channelId, rootId } = this.decodeThreadId(threadId);
    const tags = [["h", channelId]];
    if (rootId) tags.push(["e", rootId, "", "reply"]);
    tags.push(["ms", String(Date.now() % 1000)]);
    const event = await this.publish({ kind: KIND_MESSAGE, content: this.render(message), tags });
    this.rememberOwn(event.id, channelId);
    return { id: event.id, raw: event, threadId };
  }

  async postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<Event>> {
    const id = channelId.startsWith(`${NAME}:`) ? channelId.slice(NAME.length + 1) : channelId;
    const posted = await this.postMessage(this.encodeThreadId({ channelId: id }), message);
    // A top-level message starts its own thread.
    return { ...posted, threadId: this.encodeThreadId({ channelId: id, rootId: posted.id }) };
  }

  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<Event>> {
    const { channelId } = this.decodeThreadId(threadId);
    const event = await this.publish({ kind: KIND_EDIT, content: this.render(message), tags: [["h", channelId], ["e", messageId]] });
    return { id: messageId, raw: event, threadId };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { channelId } = this.decodeThreadId(threadId);
    // An agent in Buzz deletes its own messages with NIP-09; group deletes are for admins.
    await this.publish({ kind: this.host ? 5 : KIND_DELETE, content: "", tags: [["h", channelId], ["e", messageId]] });
    this.ownMessages.delete(messageId);
  }

  async addReaction(_threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    await this.publish({ kind: KIND_REACTION, content: emojiText(emoji), tags: [["e", messageId]] });
  }

  async removeReaction(_threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const content = emojiText(emoji);
    const mine = await this.query([{ kinds: [KIND_REACTION], authors: [this.botUserId], "#e": [messageId] }]);
    const targets = mine.filter((r) => r.content === content);
    if (targets.length) await this.publish({ kind: 5, content: "", tags: targets.map((r) => ["e", r.id]) });
  }

  async startTyping(threadId: string): Promise<void> {
    const { channelId, rootId } = this.decodeThreadId(threadId);
    const tags = [["h", channelId]];
    if (rootId) tags.push(["e", rootId, "", "reply"]);
    if (this.host) await this.host.publish({ kind: KIND_TYPING, content: "", tags }).catch(() => undefined);
    else this.relay!.publishQuietly(this.sign({ kind: KIND_TYPING, content: "", tags, created_at: now() }));
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  /** Cards go out as Markdown fallback plus a `buzz-card` block for the Chat Cards plugin. */
  private render(message: AdapterPostableMessage): string {
    const card = cardOf(message);
    const content = card
      ? formatCardMessage(card as unknown as Card, fallbackOf(message) ?? this.converter.renderPostable(card))
      : convertEmojiPlaceholders(this.converter.renderPostable(message), "gchat");
    if (new TextEncoder().encode(content).length > MAX_CONTENT) throw new Error("Buzz messages are limited to 64 KiB.");
    return content;
  }

  // --- reads ---------------------------------------------------------------

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { channelId, rootId } = this.decodeThreadId(threadId);
    return { id: threadId, channelId: `${NAME}:${channelId}`, isDM: false, metadata: { channelId, rootId } };
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<Event> | null> {
    const [event] = await this.query([{ ids: [messageId], kinds: [KIND_MESSAGE], limit: 1 }]);
    if (!event) return null;
    const [message] = await this.withEdits([event], threadId);
    return message ?? null;
  }

  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<Event>> {
    const { channelId, rootId } = this.decodeThreadId(threadId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const forward = options.direction === "forward";
    const cursor = options.cursor ? Number(options.cursor) : undefined;
    const page: Filter = { kinds: [KIND_MESSAGE], "#h": [channelId], limit };
    if (cursor !== undefined) forward ? (page.since = cursor) : (page.until = cursor);
    const filters: Filter[] = rootId ? [{ ...page, "#e": [rootId] }] : [page];
    if (rootId && (cursor === undefined || !forward)) filters.push({ ids: [rootId], limit: 1 });
    const events = dedupe(await this.query(filters))
      .filter((e) => (rootId ? e.id === rootId || threadRoot(e) === rootId : !threadRoot(e)))
      .filter((e) => cursor === undefined || (forward ? e.created_at > cursor : e.created_at < cursor))
      .sort((a, b) => sentAt(a) - sentAt(b) || (a.id === rootId ? -1 : b.id === rootId ? 1 : 0));
    const chosen = forward ? events.slice(0, limit) : events.slice(-limit);
    const messages = await this.withEdits(chosen, threadId);
    const edge = forward ? chosen.at(-1) : chosen[0];
    return { messages, ...(chosen.length === limit && edge ? { nextCursor: String(edge.created_at) } : {}) };
  }

  /** Applies each message's latest edit by its author and drops deleted messages. */
  private async withEdits(events: Event[], threadId: string): Promise<Message<Event>[]> {
    if (!events.length) return [];
    const ids = events.map((e) => e.id);
    const changes = await this.query([{ kinds: [KIND_EDIT, KIND_DELETE, 5], "#e": ids }]);
    const authorOf = new Map(events.map((e) => [e.id, e.pubkey]));
    const edits = new Map<string, Event>();
    const deleted = new Set<string>();
    for (const change of changes) {
      const target = tagValue(change, "e");
      if (!target || authorOf.get(target) !== change.pubkey) continue;
      if (change.kind === KIND_EDIT) {
        const current = edits.get(target);
        if (!current || change.created_at >= current.created_at) edits.set(target, change);
      } else deleted.add(target);
    }
    const kept = events.filter((e) => !deleted.has(e.id));
    return Promise.all(kept.map(async (e) => {
      const { channelId } = this.decodeThreadId(threadId);
      const own = this.encodeThreadId({ channelId, rootId: threadRoot(e) ?? e.id });
      return this.buildMessage(e, own, await this.author(e.pubkey), edits.get(e.id));
    }));
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    if (!EVENT_ID.test(userId)) return null;
    const cached = this.profiles.get(userId);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.info;
    const [profile] = (await this.query([{ kinds: [0], authors: [userId], limit: 1 }])).sort((a, b) => b.created_at - a.created_at);
    let fields: Record<string, unknown> = {};
    try {
      fields = profile ? (JSON.parse(profile.content) as Record<string, unknown>) : {};
    } catch {}
    const name = text(fields.display_name) || text(fields.name) || userId.slice(0, 8);
    const info: UserInfo = { userId, userName: text(fields.name) || name, fullName: name, isBot: fields.bot === true };
    if (text(fields.picture)) info.avatarUrl = text(fields.picture);
    this.profiles.set(userId, { info, at: Date.now() });
    return info;
  }

  private async author(pubkey: string): Promise<Author> {
    const info = await this.getUser(pubkey).catch(() => null);
    if (!info) return this.fallbackAuthor(pubkey);
    return { userId: pubkey, userName: info.userName, fullName: info.fullName, isBot: info.isBot || "unknown", isMe: pubkey === this.botUserId };
  }

  private fallbackAuthor(pubkey: string): Author {
    const short = pubkey.slice(0, 8);
    return { userId: pubkey, userName: short, fullName: short, isBot: "unknown", isMe: pubkey === this.botUserId };
  }

  // --- signing -------------------------------------------------------------

  private sign(template: Omit<EventTemplate, "created_at"> & { created_at?: number }): Event {
    return finalizeEvent({ created_at: now(), ...template }, this.secretKey!);
  }

  private async publish(template: BuzzEventTemplate): Promise<Event> {
    if (this.host) return this.host.publish(template);
    const event = this.sign(template);
    await this.relay!.publish(event);
    return event;
  }

  private query(filters: Filter[]): Promise<Event[]> {
    return this.host ? this.host.query(filters) : this.relay!.query(filters);
  }

  private rememberOwn(id: string, channelId: string): void {
    this.ownMessages.set(id, channelId);
    if (this.ownMessages.size > 5000) this.ownMessages.delete(this.ownMessages.keys().next().value!);
  }
}

export function createBuzzAdapter(config: BuzzAdapterConfig = {}): BuzzAdapter {
  return new BuzzAdapter(config);
}

// --- helpers ---------------------------------------------------------------

function readSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = decodeNip19(trimmed);
    if (decoded.type !== "nsec") throw new Error("Buzz adapter: secretKey is not an nsec.");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("Buzz adapter: secretKey must be 64 hex characters or nsec1….");
  return Uint8Array.from(trimmed.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** NIP-10: the `root` marker, else a lone `reply` marker, names the thread root. */
function threadRoot(event: Event): string | undefined {
  const refs = event.tags.filter((t) => t[0] === "e" && typeof t[1] === "string" && EVENT_ID.test(t[1]));
  return (refs.find((t) => t[3] === "root") ?? refs.find((t) => t[3] === "reply"))?.[1];
}

function cardOf(message: AdapterPostableMessage): CardElement | null {
  if (isCardElement(message)) return message;
  if (typeof message === "object" && message !== null && "card" in message && isCardElement(message.card)) return message.card;
  return null;
}

function fallbackOf(message: AdapterPostableMessage): string | undefined {
  return typeof message === "object" && message !== null && "fallbackText" in message && typeof message.fallbackText === "string"
    ? message.fallbackText
    : undefined;
}

function emojiText(emoji: EmojiValue | string): string {
  return typeof emoji === "string" ? emoji : defaultEmojiResolver.toGChat(emoji);
}

/** Buzz orders by `created_at` plus the event's `ms` tag, as clients do. */
function sentAt(event: Event): number {
  const ms = Number(tagValue(event, "ms"));
  return event.created_at * 1000 + (Number.isInteger(ms) && ms >= 0 && ms < 1000 ? ms : 0);
}

function dedupe(events: Event[]): Event[] {
  return [...new Map(events.map((e) => [e.id, e])).values()];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
