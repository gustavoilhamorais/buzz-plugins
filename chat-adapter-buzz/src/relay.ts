// A small Nostr relay client for a Buzz relay: one WebSocket, NIP-42 AUTH
// before anything else, live subscriptions that survive reconnects, one-shot
// queries, and publishes that wait for the relay's OK.

import type { Filter } from "nostr-tools/filter";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";

export type Sign = (template: EventTemplate) => Event;

export type RelayLogger = {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
};

export type RelayOptions = {
  url: string;
  sign: Sign;
  /** Extra tags for the AUTH event, such as a NIP-OA `auth` tag. */
  authTags?: string[][];
  logger?: RelayLogger;
  /** How long to wait for the relay's AUTH challenge, OK replies and query results. */
  timeoutMs?: number;
  /** Delays between reconnect attempts; the last one repeats. */
  backoffMs?: number[];
};

type Live = { filters: Filter[]; onEvent: (event: Event) => void; since?: number };
type Pending = { resolve: (value: OkReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Query = { events: Event[]; resolve: (events: Event[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type OkReply = { accepted: boolean; message: string };

export class RelayError extends Error {}

const SEEN_LIMIT = 5000;
const silent: RelayLogger = { debug() {}, warn() {}, error() {} };

export class RelayClient {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private authenticated = false;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextQuery = 0;
  private readonly live = new Map<string, Live>();
  private readonly oks = new Map<string, Pending>();
  private readonly queries = new Map<string, Query>();
  private readonly seen = new Set<string>();
  private challenge: ((value: string) => void) | null = null;
  private readonly log: RelayLogger;
  private readonly timeoutMs: number;
  private readonly backoffMs: number[];

  private readonly options: RelayOptions;

  constructor(options: RelayOptions) {
    this.options = options;
    this.log = options.logger ?? silent;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.backoffMs = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
  }

  /** Connects and authenticates; later calls wait for the current connection. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new RelayError("The relay client is closed."));
    this.ready ??= this.open().catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  /** Delivers matching events now and after every reconnect, deduplicated. */
  subscribe(id: string, filters: Filter[], onEvent: (event: Event) => void): void {
    this.live.set(id, { filters, onEvent });
    if (this.authenticated) this.sendReq(id);
  }

  unsubscribe(id: string): void {
    if (this.live.delete(id)) this.send(["CLOSE", id]);
  }

  /** Stored events matching `filters`, up to the relay's EOSE. */
  async query(filters: Filter[]): Promise<Event[]> {
    await this.connect();
    const id = `q${++this.nextQuery}`;
    return new Promise<Event[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(id);
        this.send(["CLOSE", id]);
        reject(new RelayError("The relay did not finish the query in time."));
      }, this.timeoutMs);
      this.queries.set(id, { events: [], resolve, reject, timer });
      this.send(["REQ", id, ...filters]);
    });
  }

  /** Publishes a signed event and resolves once the relay accepts it. */
  async publish(event: Event): Promise<void> {
    await this.connect();
    const ok = await this.waitForOk(event.id, () => this.send(["EVENT", event]));
    if (!ok.accepted) throw new RelayError(`The relay refused the event: ${ok.message || "no reason given"}`);
  }

  /** Sends without waiting for an OK, for ephemeral events such as typing. */
  async publishQuietly(event: Event): Promise<void> {
    await this.connect();
    this.send(["EVENT", event]);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.failPending(new RelayError("The relay client is closed."));
  }

  // --- connection ----------------------------------------------------------

  private async open(): Promise<void> {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    const challenge = new Promise<string>((resolve) => (this.challenge = resolve));
    socket.onmessage = (message) => this.receive(message.data);
    socket.onclose = () => this.dropped(socket);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new RelayError(`Couldn’t connect to ${this.options.url}.`));
    });
    socket.onerror = (error) => this.log.warn("Buzz relay socket error", error);

    // Buzz relays send an AUTH challenge on connect and refuse other work until it's answered.
    const value = await this.within(challenge, "The relay sent no AUTH challenge.");
    const auth = this.options.sign({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [["relay", this.options.url], ["challenge", value], ...(this.options.authTags ?? [])],
    });
    const ok = await this.waitForOk(auth.id, () => this.send(["AUTH", auth]));
    if (!ok.accepted) {
      this.closed = true;
      socket.close();
      throw new RelayError(`The relay refused authentication: ${ok.message || "no reason given"}`);
    }
    this.attempt = 0;
    this.authenticated = true;
    this.log.debug("Authenticated to Buzz relay", this.options.url);
    for (const id of this.live.keys()) this.sendReq(id);
  }

  private dropped(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = null;
    this.authenticated = false;
    this.challenge = null;
    this.failPending(new RelayError("The relay connection closed."));
    if (this.closed) return;
    const delay = this.backoffMs[Math.min(this.attempt++, this.backoffMs.length - 1)]!;
    this.log.warn(`Buzz relay connection closed; reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error: unknown) => this.log.error("Buzz relay reconnect failed", error));
    }, delay);
  }

  private failPending(error: Error): void {
    for (const pending of this.oks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.oks.clear();
    for (const query of this.queries.values()) {
      clearTimeout(query.timer);
      query.reject(error);
    }
    this.queries.clear();
  }

  // --- protocol ------------------------------------------------------------

  private sendReq(id: string): void {
    const live = this.live.get(id)!;
    // After a reconnect, ask only for what may have been missed; `seen` drops repeats.
    const filters = live.since === undefined ? live.filters : live.filters.map((f) => ({ ...f, since: Math.max(f.since ?? 0, live.since! - 1) }));
    this.send(["REQ", id, ...filters]);
  }

  private receive(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, a, b, c] = message as [string, unknown, unknown, unknown];
    switch (type) {
      case "AUTH":
        if (typeof a === "string") {
          if (this.challenge) this.challenge(a);
          this.challenge = null;
        }
        return;
      case "OK": {
        const pending = typeof a === "string" ? this.oks.get(a) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.oks.delete(a as string);
        pending.resolve({ accepted: b === true, message: typeof c === "string" ? c : "" });
        return;
      }
      case "EVENT": {
        if (typeof a !== "string" || !isEvent(b) || !verifyEvent(b)) return;
        const query = this.queries.get(a);
        if (query) return void query.events.push(b);
        const live = this.live.get(a);
        if (!live || this.seen.has(b.id)) return;
        this.remember(b.id);
        live.since = Math.max(live.since ?? 0, b.created_at);
        try {
          live.onEvent(b);
        } catch (error) {
          this.log.error("Buzz event handler failed", error);
        }
        return;
      }
      case "EOSE": {
        const query = typeof a === "string" ? this.queries.get(a) : undefined;
        if (!query) return;
        clearTimeout(query.timer);
        this.queries.delete(a as string);
        this.send(["CLOSE", a]);
        query.resolve(query.events);
        return;
      }
      case "CLOSED": {
        const reason = typeof b === "string" ? b : "";
        const query = typeof a === "string" ? this.queries.get(a) : undefined;
        if (query) {
          clearTimeout(query.timer);
          this.queries.delete(a as string);
          query.reject(new RelayError(`The relay closed the query: ${reason}`));
        } else if (typeof a === "string" && this.live.has(a)) {
          this.log.error(`The relay closed subscription ${a}: ${reason}`);
        }
        return;
      }
      case "NOTICE":
        this.log.warn("Buzz relay notice", a);
        return;
    }
  }

  private waitForOk(id: string, send: () => void): Promise<OkReply> {
    return new Promise<OkReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.oks.delete(id);
        reject(new RelayError("The relay did not answer in time."));
      }, this.timeoutMs);
      this.oks.set(id, { resolve, reject, timer });
      send();
    });
  }

  private within<T>(promise: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelayError(message)), this.timeoutMs);
      promise.then(
        (value) => (clearTimeout(timer), resolve(value)),
        (error: unknown) => (clearTimeout(timer), reject(error)),
      );
    });
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
  }

  private send(message: unknown[]): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

function isEvent(value: unknown): value is Event {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.pubkey === "string" && typeof e.sig === "string" && typeof e.kind === "number" &&
    typeof e.created_at === "number" && typeof e.content === "string" && Array.isArray(e.tags);
}
