import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { streamCard, toCard } from "@json-render/chat";
import { Chat, type ActionEvent } from "chat";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { createBuzzAdapter, type BuzzAdapter } from "../src/index.ts";
import { RelayClient } from "../src/relay.ts";
import { formatAction, parseCardMessage } from "../src/wire.ts";
import { MockRelay } from "./mock-relay.ts";

// A fresh channel per test keeps one test's events out of the next.
let CHANNEL = "";
let channels = 0;
const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");
const botKey = generateSecretKey();
const userKey = generateSecretKey();
const bot = getPublicKey(botKey);
const user = getPublicKey(userKey);

const spec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Deploy v2?" }, children: ["intro", "acts"] },
    intro: { type: "Text", props: { content: "Tests are green." }, children: [] },
    acts: { type: "Actions", props: {}, children: ["ok"] },
    ok: { type: "Button", props: { id: "approve", label: "Approve", style: "primary", value: "v2" }, children: [] },
  },
};

let relay: MockRelay;
let person: RelayClient;
let chat: Chat<{ buzz: BuzzAdapter }> | null = null;

before(async () => {
  relay = await MockRelay.start();
  person = new RelayClient({ url: relay.url, sign: (t) => finalizeEvent(t, userKey), timeoutMs: 2000, backoffMs: [50] });
  await person.connect();
});

after(async () => {
  await chat?.shutdown();
  person.close();
  await relay.stop();
});

beforeEach(async () => {
  CHANNEL = `test-channel-${++channels}`;
  await chat?.shutdown();
  chat = null;
  relay.members = null;
});

async function startBot(options: { authTag?: string[]; channels?: string[] } = {}) {
  const adapter = createBuzzAdapter({
    relayUrl: relay.url,
    secretKey: hex(botKey),
    channels: [CHANNEL],
    userName: "deploybot",
    ...options,
  });
  chat = new Chat({ userName: "deploybot", adapters: { buzz: adapter }, state: createMemoryState(), logger: "silent" });
  await chat.initialize();
  return { chat, adapter };
}

/** Publishes a message as the person, mentioning the bot unless told otherwise. */
async function say(content: string, options: { root?: string; mention?: boolean; channel?: string } = {}): Promise<Event> {
  const tags = [["h", options.channel ?? CHANNEL]];
  if (options.root) tags.push(["e", options.root, "", "reply"]);
  if (options.mention !== false) tags.push(["p", bot]);
  const template: EventTemplate = { kind: 9, content, tags, created_at: Math.floor(Date.now() / 1000) };
  const event = finalizeEvent(template, userKey);
  await person.publish(event);
  return event;
}

async function until<T>(read: () => T | undefined | false, what: string, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The bot's events of one kind in the current test's channel (reactions carry no channel). */
const fromBot = (kind: number) =>
  relay.events.filter((e) => e.pubkey === bot && e.kind === kind && (kind === 7 || kind === 5 || e.tags.some((t) => t[0] === "h" && t[1] === CHANNEL)));

test("authenticates with NIP-42 and sends the owner's NIP-OA tag", async () => {
  const authTag = ["auth", "a".repeat(64), "kind=9", "b".repeat(128)];
  await startBot({ authTag });
  const auth = relay.auths.findLast((e) => e.pubkey === bot);
  assert.ok(auth);
  assert.deepEqual(auth.tags.find((t) => t[0] === "auth"), authTag);
});

test("a refused AUTH fails initialization with the relay's reason", async () => {
  relay.members = new Set([user]);
  await assert.rejects(startBot(), /refused authentication: restricted: not a member/);
});

test("a mention reaches onNewMention and the card reply lands in its thread", async () => {
  const { chat } = await startBot();
  const mentioned: string[] = [];
  chat.onNewMention(async (thread, message) => {
    mentioned.push(message.text);
    assert.equal(message.author.userId, user);
    assert.equal(message.isMention, true);
    await thread.subscribe();
    await thread.post(toCard(spec as never));
  });
  const ask = await say("@deploybot ship it?");
  const reply = await until(() => fromBot(9).find((e) => e.tags.some((t) => t[0] === "e" && t[1] === ask.id)), "the bot's reply");
  assert.deepEqual(mentioned, ["@deploybot ship it?"]);
  assert.deepEqual(reply.tags.find((t) => t[0] === "h"), ["h", CHANNEL]);
  assert.deepEqual(reply.tags.find((t) => t[0] === "e"), ["e", ask.id, "", "reply"]);
  const parsed = parseCardMessage(reply.content);
  assert.equal(parsed?.status, "ok");
  assert.match(parsed!.before, /Deploy v2\?/, "the fallback text names the card");
});

test("a choice on the bot's card reaches onAction with value, values and the person", async () => {
  const { chat } = await startBot();
  const actions: ActionEvent[] = [];
  chat.onNewMention(async (thread) => void (await thread.post(toCard(spec as never))));
  chat.onAction("approve", async (event) => void actions.push(event));
  const ask = await say("@deploybot ship it?");
  const card = await until(() => fromBot(9).find((e) => e.tags.some((t) => t[1] === ask.id)), "the card");

  await say(formatAction({ message: card.id, action: "approve", value: "v2", values: { note: "go" } }, "Approve"), { root: ask.id });
  const event = await until(() => actions[0], "the action");
  assert.equal(event.actionId, "approve");
  assert.equal(event.value, "v2");
  assert.deepEqual(event.values, { note: "go" });
  assert.equal(event.messageId, card.id);
  assert.equal(event.user.userId, user);
  assert.equal(event.threadId, `buzz:${CHANNEL}:${ask.id}`);
});

test("a choice naming a message the bot didn't post is ignored", async () => {
  const { chat } = await startBot();
  const actions: ActionEvent[] = [];
  const messages: string[] = [];
  chat.onAction(async (event) => void actions.push(event));
  chat.onNewMention(async (_thread, message) => void messages.push(message.text));
  const forged = await say("not a card", { mention: false });
  await say(formatAction({ message: forged.id, action: "approve" }, "Approve"), { root: forged.id });
  await say("@deploybot ping");
  await until(() => messages.includes("@deploybot ping"), "a later mention");
  assert.equal(actions.length, 0);
  assert.ok(!messages.some((m) => m.includes("buzz-card-action")), "a choice is never delivered as a message");
});

test("streamCard posts once and edits the same message; history shows the final card", async () => {
  const { chat, adapter } = await startBot();
  let threadId = "";
  chat.onNewMention(async (thread) => {
    threadId = thread.id;
    // One JSON Patch line per element, the way a model streams a spec.
    const lines = [
      { op: "add", path: "/root", value: "card" },
      ...Object.entries(spec.elements).map(([id, element]) => ({ op: "add", path: `/elements/${id}`, value: element })),
    ].map((patch) => JSON.stringify(patch) + "\n");
    async function* stream() {
      for (const line of lines) {
        yield line;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    await streamCard(thread, stream());
  });
  await say("@deploybot stream it");
  const posted = await until(() => fromBot(9)[0], "the streamed card");
  await until(() => threadId && fromBot(40003).some((e) => parseCardMessage(e.content)?.status === "ok" && e.content.includes("Approve")), "the final edit");
  assert.equal(fromBot(9).length, 1, "streaming edits one message instead of posting many");
  assert.ok(fromBot(40003).every((e) => e.tags.some((t) => t[0] === "e" && t[1] === posted.id)));

  const history = await adapter.fetchMessages(threadId);
  const last = history.messages.at(-1)!;
  assert.equal(last.id, posted.id);
  assert.equal(last.metadata.edited, true);
  assert.match(last.text, /Approve/);
});

test("subscribed threads keep working after the relay drops the connection", async () => {
  const { chat } = await startBot();
  const seen: string[] = [];
  chat.onNewMention(async (thread) => void (await thread.subscribe()));
  chat.onSubscribedMessage(async (_thread, message) => void seen.push(message.text));
  const ask = await say("@deploybot watch this");
  await until(() => seen.length === 0 && relay.connections >= 2, "both connections");
  const authsOf = (key: string) => relay.auths.filter((e) => e.pubkey === key).length;
  const [botAuths, userAuths] = [authsOf(bot), authsOf(user)];
  relay.dropConnections();
  await until(() => authsOf(bot) > botAuths && authsOf(user) > userAuths, "both clients to authenticate again", 5000);
  await say("after the restart", { root: ask.id, mention: false });
  await until(() => seen.includes("after the restart"), "the follow-up in the subscribed thread", 5000);
});

test("typing, reactions and deletes use Buzz event kinds", async () => {
  const { adapter } = await startBot();
  const ask = await say("hello", { mention: false });
  const threadId = `buzz:${CHANNEL}:${ask.id}`;
  await adapter.startTyping(threadId);
  await adapter.addReaction(threadId, ask.id, "👍");
  const reaction = await until(() => fromBot(7)[0], "the reaction");
  assert.deepEqual(reaction.tags, [["e", ask.id]]);
  await adapter.removeReaction(threadId, ask.id, "👍");
  const removal = await until(() => fromBot(5)[0], "the reaction removal");
  assert.deepEqual(removal.tags, [["e", reaction.id]]);
  const posted = await adapter.postMessage(threadId, "bye");
  await adapter.deleteMessage(threadId, posted.id);
  assert.deepEqual(fromBot(9005)[0]?.tags, [["h", CHANNEL], ["e", posted.id]]);
  const history = await adapter.fetchMessages(threadId);
  assert.deepEqual(history.messages.map((m) => m.id), [ask.id], "deleted messages leave history");
});

test("thread ids round-trip and reject anything else", async () => {
  const { adapter } = await startBot();
  const root = "c".repeat(64);
  assert.deepEqual(adapter.decodeThreadId(`buzz:${CHANNEL}:${root}`), { channelId: CHANNEL, rootId: root });
  assert.equal(adapter.encodeThreadId({ channelId: CHANNEL }), `buzz:${CHANNEL}`);
  assert.equal(adapter.channelIdFromThreadId(`buzz:${CHANNEL}:${root}`), `buzz:${CHANNEL}`);
  for (const bad of ["slack:C1", `buzz:${CHANNEL}:nothex`, "buzz:has space", `buzz:${CHANNEL}:${root}:x`])
    assert.throws(() => adapter.decodeThreadId(bad));
});

test("the adapter's wire format is the plugin's", () => {
  const plugin = readFileSync(new URL("../../chat-cards/src/wire.ts", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../src/wire.ts", import.meta.url), "utf8");
  assert.equal(adapter, plugin, "copy chat-cards/src/wire.ts to chat-adapter-buzz/src/wire.ts");
});

const relayKey = generateSecretKey();
const relaySigned = (kind: number, tags: string[][]) =>
  finalizeEvent({ kind, content: "", tags, created_at: Math.floor(Date.now() / 1000) }, relayKey);

test("without channels, the bot follows its memberships", async () => {
  const other = `${CHANNEL}-other`;
  const later = `${CHANNEL}-later`;
  relay.inject(relaySigned(39002, [["d", CHANNEL], ["p", user], ["p", bot]]));
  relay.inject(relaySigned(39002, [["d", other], ["p", user]]));
  const { chat, adapter } = await startBot({ channels: [] });
  assert.deepEqual(adapter.listening, [CHANNEL]);
  const heard: string[] = [];
  chat.onNewMention(async (_thread, message) => void heard.push(message.text));

  await say("@deploybot here", { channel: other });
  await say("@deploybot in my channel");
  await until(() => heard.includes("@deploybot in my channel"), "a mention in a member channel");
  assert.ok(!heard.includes("@deploybot here"), "channels the bot isn't in are ignored");

  relay.inject(relaySigned(44100, [["p", bot], ["h", later]]));
  await until(() => adapter.listening.includes(later), "the added channel");
  await say("@deploybot welcome", { channel: later });
  await until(() => heard.includes("@deploybot welcome"), "a mention in the added channel");

  relay.inject(relaySigned(44101, [["p", bot], ["h", later]]));
  await until(() => !adapter.listening.includes(later), "the removed channel");
});
