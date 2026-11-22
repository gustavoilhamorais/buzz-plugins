// The bot's side of the Chat SDK plugin for Buzz 1.x. The plugin starts the bot
// as a process for one agent and talks to it in JSON lines tagged `"buzz":1`:
//
//   plugin → bot   {"buzz":1,"type":"start","agent":{"pubkey","owner","name"}}
//                  {"buzz":1,"type":"event","event":{…}}           a message for the agent
//                  {"buzz":1,"type":"reply","id":1,"ok":true,"value":…}
//                  {"buzz":1,"type":"stop"}
//   bot → plugin   {"buzz":1,"type":"publish","id":1,"template":{"kind","content","tags"}}
//                  {"buzz":1,"type":"query","id":2,"filters":[…]}
//
// Other stdout lines are logs. Buzz signs and publishes as the agent; the bot never
// sees a key or a sign-in.

import { createInterface } from "node:readline";
import type { Filter } from "nostr-tools/filter";
import type { Event } from "nostr-tools/pure";
import type { BuzzEventTemplate, BuzzHost } from "./index.ts";

export const PROTOCOL = 1;

export type StdioAgent = { pubkey: string; owner?: string; name?: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class StdioHost implements BuzzHost {
  readonly pubkey: string;
  readonly owner: string | undefined;
  readonly name: string | undefined;
  private readonly output: NodeJS.WritableStream;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: ((event: Event) => void)[] = [];
  private readonly early: Event[] = [];
  private readonly stopListeners: (() => void)[] = [];
  private next = 1;
  private closed = false;

  constructor(agent: StdioAgent, output: NodeJS.WritableStream) {
    this.pubkey = agent.pubkey;
    this.owner = agent.owner;
    this.name = agent.name;
    this.output = output;
  }

  publish(template: BuzzEventTemplate): Promise<Event> {
    return this.request("publish", { template }) as Promise<Event>;
  }

  query(filters: Filter[]): Promise<Event[]> {
    return this.request("query", { filters }) as Promise<Event[]>;
  }

  onEvent(listener: (event: Event) => void): void {
    this.listeners.push(listener);
    for (const event of this.early.splice(0)) listener(event);
  }

  /** Calls `listener` when the plugin stops the bot or its input ends. */
  onStop(listener: () => void): void {
    this.stopListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("Buzz stopped the bot"));
    this.pending.clear();
  }

  /** Handles one message from the plugin. */
  handle(message: Record<string, unknown>): void {
    if (message.type === "event" && isEvent(message.event)) {
      if (this.listeners.length) for (const listener of this.listeners) listener(message.event);
      else this.early.push(message.event);
    } else if (message.type === "reply" && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new Error(typeof message.error === "string" ? message.error : "Buzz refused the request"));
    } else if (message.type === "stop") {
      this.stop();
    }
  }

  stop(): void {
    this.close();
    for (const listener of this.stopListeners.splice(0)) listener();
  }

  private request(type: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Buzz stopped the bot"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(JSON.stringify({ buzz: PROTOCOL, type, id, ...body }) + "\n");
    });
  }
}

/**
 * Waits for the plugin's `start` and returns the host for that agent. Reads the
 * plugin's messages from `input` until it ends.
 */
export function connectStdioHost(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<StdioHost> {
  return new Promise((resolve, reject) => {
    let host: StdioHost | null = null;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.buzz !== PROTOCOL) return;
      if (!host) {
        const agent = message.agent as StdioAgent | undefined;
        if (message.type !== "start" || !agent || !/^[0-9a-f]{64}$/.test(agent.pubkey ?? "")) return;
        host = new StdioHost(agent, output);
        resolve(host);
        return;
      }
      host.handle(message);
    });
    lines.on("close", () => {
      if (host) host.stop();
      else reject(new Error("Buzz closed the connection before starting the bot"));
    });
  });
}

function isEvent(value: unknown): value is Event {
  const e = value as Event | null;
  return !!e && typeof e.id === "string" && typeof e.pubkey === "string" && typeof e.kind === "number" && typeof e.content === "string" && Array.isArray(e.tags) && typeof e.created_at === "number";
}
