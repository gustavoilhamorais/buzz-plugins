// An in-memory Nostr relay that behaves like a Buzz relay where it matters to
// the adapter: AUTH challenge on connect, nothing before AUTH, signed events
// only from the authenticated key, NIP-01 filters, and live fan-out.

import { WebSocketServer, type WebSocket } from "ws";
import { verifyEvent, type Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";

type Client = { socket: WebSocket; challenge: string; pubkey?: string; subs: Map<string, Filter[]> };

export class MockRelay {
  readonly events: Event[] = [];
  readonly auths: Event[] = [];
  /** When set, only these keys may authenticate. */
  members: Set<string> | null = null;
  private readonly server: WebSocketServer;
  private readonly clients = new Set<Client>();
  url = "";

  private constructor() {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket) => this.accept(socket));
  }

  static async start(): Promise<MockRelay> {
    const relay = new MockRelay();
    await new Promise<void>((resolve) => relay.server.once("listening", () => resolve()));
    const address = relay.server.address();
    relay.url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    return relay;
  }

  /** Closes every client connection, as a relay restart would. */
  dropConnections(): void {
    for (const client of this.clients) client.socket.terminate();
  }

  get connections(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    const client: Client = { socket, challenge: Math.random().toString(36).slice(2), subs: new Map() };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    socket.on("message", (data) => this.handle(client, String(data)));
    this.send(client, ["AUTH", client.challenge]);
  }

  private handle(client: Client, data: string): void {
    const [type, ...rest] = JSON.parse(data) as [string, ...unknown[]];
    if (type === "AUTH") {
      const event = rest[0] as Event;
      const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
      const ok = verifyEvent(event) && event.kind === 22242 && tag("challenge") === client.challenge && tag("relay") === this.url &&
        (!this.members || this.members.has(event.pubkey));
      if (ok) {
        client.pubkey = event.pubkey;
        this.auths.push(event);
      }
      return this.send(client, ["OK", event.id, ok, ok ? "" : "restricted: not a member"]);
    }
    if (type === "REQ") {
      const [id, ...filters] = rest as [string, ...Filter[]];
      if (!client.pubkey) return this.send(client, ["CLOSED", id, "auth-required: authenticate first"]);
      client.subs.set(id, filters);
      for (const event of this.stored(filters)) this.send(client, ["EVENT", id, event]);
      return this.send(client, ["EOSE", id]);
    }
    if (type === "CLOSE") return void client.subs.delete(rest[0] as string);
    if (type === "EVENT") {
      const event = rest[0] as Event;
      if (!client.pubkey) return this.send(client, ["OK", event.id, false, "auth-required: authenticate first"]);
      if (!verifyEvent(event) || event.pubkey !== client.pubkey) return this.send(client, ["OK", event.id, false, "invalid: bad signature or author"]);
      // Typing indicators (2xxxx) are ephemeral: fanned out, never stored.
      if (event.kind < 20000 || event.kind >= 30000) this.events.push(event);
      this.send(client, ["OK", event.id, true, ""]);
      for (const other of this.clients)
        for (const [id, filters] of other.subs) if (filters.some((f) => matches(f, event))) this.send(other, ["EVENT", id, event]);
    }
  }

  private stored(filters: Filter[]): Event[] {
    const out = new Map<string, Event>();
    for (const filter of filters) {
      const hits = this.events.filter((e) => matches(filter, e)).sort((a, b) => b.created_at - a.created_at);
      for (const e of filter.limit === undefined ? hits : hits.slice(0, filter.limit)) out.set(e.id, e);
    }
    return [...out.values()];
  }

  private send(client: Client, message: unknown[]): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
  }
}

export function matches(filter: Filter, event: Event): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}
