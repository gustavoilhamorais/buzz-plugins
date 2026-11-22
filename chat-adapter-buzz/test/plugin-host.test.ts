// The Chat SDK agents plugin (../../chat-sdk-agents/plugin.js) running the real
// example bot, with a fake Buzz around it: `host.spawn` starts the process and the
// agent's handle signs with a test key, as Buzz signs as the agent.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { test } from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { formatAction, parseCardMessage } from "../src/wire.ts";
import type { Filter } from "nostr-tools/filter";
import { matches } from "./mock-relay.ts";

const pluginUrl = new URL("../../chat-sdk-agents/plugin.js", import.meta.url).href;
const packageDir = new URL("..", import.meta.url).pathname;

type Plugin = {
  inject: string[];
  apply(ctx: unknown): void;
  template(value: unknown): unknown;
};

function fakeBuzz(agentKey: Uint8Array, owner: string) {
  const pubkey = getPublicKey(agentKey);
  const agent = { key: pubkey, pubkey, owner, name: "Cards", relay: "wss://community.example", type: "", config: { cwd: packageDir, script: "examples/card-bot.ts", respondTo: "owner-only" } };
  const events: Event[] = [];
  const output: string[] = [];
  let type: { run(delivery: unknown): void; id: string } | undefined;
  const effects: (() => void)[] = [];
  const kills: (() => void)[] = [];
  const ctx = {
    pluginOwner: { id: "io.github.gustavoilhamorais.chat-sdk-agents" },
    effect: (setup: () => () => void) => effects.push(setup()),
    agents: {
      register(t: typeof type) {
        type = t;
      },
      snapshot: () => ({ status: "ready", running: [] }),
      subscribe: () => () => undefined,
      handle: (key: string) =>
        key !== agent.key
          ? undefined
          : {
              publish: async (template: { kind: number; content: string; tags: string[][] }) => {
                const event = finalizeEvent({ ...template, created_at: Math.floor(Date.now() / 1000) }, agentKey);
                events.push(event);
                return event;
              },
              query: async (filters: Filter[]) => events.filter((e) => filters.some((f) => matches(f, e))),
            },
    },
    host: {
      spawn: async (id: string, options: { args: string[]; cwd: string; env: Record<string, string | null>; onStdout(d: string): void; onStderr(d: string): void }) => {
        assert.equal(id, "bot");
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries({ ...process.env, ...options.env })) if (typeof v === "string") env[k] = v;
        const cwd = options.cwd.startsWith("~/") ? homedir() + options.cwd.slice(1) : options.cwd;
        const child = spawn(process.execPath, options.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
          output.push(d);
          options.onStdout(d);
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          output.push(d);
          options.onStderr(d);
        });
        const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
        kills.push(() => child.kill());
        return {
          write: async (data: string) => void child.stdin.write(data),
          end: async (data = "") => void child.stdin.end(data),
          kill: async () => void child.kill(),
          exited,
        };
      },
    },
  };
  return {
    agent,
    events,
    output,
    ctx,
    get type() {
      return type;
    },
    deliver(event: Event) {
      type!.run({ trigger: { type: "mention", event }, agent, config: agent.config, signal: new AbortController().signal });
    },
    stop() {
      for (const effect of effects) effect();
      for (const kill of kills) kill();
    },
  };
}

test("the plugin registers a Chat SDK agent type whose bot answers mentions with cards and handles their buttons", async () => {
  const plugin = (await import(pluginUrl)) as Plugin;
  assert.deepEqual(plugin.inject, ["agents", "host"]);
  const agentKey = generateSecretKey();
  const ownerKey = generateSecretKey();
  const owner = getPublicKey(ownerKey);
  const buzz = fakeBuzz(agentKey, owner);
  plugin.apply(buzz.ctx);
  assert.equal(buzz.type?.id, "chat-sdk");

  const channel = "6f1d2c1e-0000-4000-8000-000000000001";
  const say = (content: string, by: Uint8Array, root?: string) =>
    finalizeEvent({ kind: 9, content, tags: [["h", channel], ["p", buzz.agent.pubkey], ...(root ? [["e", root, "", "reply"]] : [])], created_at: Math.floor(Date.now() / 1000) }, by);
  try {
    // Someone other than the owner is ignored; the owner gets a card in a thread.
    buzz.deliver(say("@Cards de outra pessoa", generateSecretKey()));
    const ask = say("@Cards oi tudo bem", ownerKey);
    buzz.deliver(ask);
    const card = await until(() => buzz.events.find((e) => e.kind === 9), "the card", () => buzz.output.join(""));
    assert.equal(parseCardMessage(card.content)?.status, "ok");
    assert.match(card.content, /oi tudo bem/);
    assert.ok(card.tags.some((t) => t[0] === "e" && t[1] === ask.id));
    assert.equal(buzz.events.filter((e) => e.kind === 9).length, 1);

    buzz.deliver(say(formatAction({ message: card.id, action: "feedback", value: "up", values: { comment: "ótimo" } }, "Útil"), ownerKey, ask.id));
    const thanks = await until(() => buzz.events.find((e) => e.kind === 40003), "the thank-you edit", () => buzz.output.join(""));
    assert.ok(thanks.tags.some((t) => t[0] === "e" && t[1] === card.id));
    assert.match(thanks.content, /ótimo/);
  } finally {
    buzz.stop();
  }
});

test("the plugin publishes only the kinds a Chat SDK bot needs", async () => {
  const plugin = (await import(pluginUrl)) as Plugin;
  assert.deepEqual(plugin.template({ kind: 9, content: "oi", tags: [["h", "c"]] }), { kind: 9, content: "oi", tags: [["h", "c"]] });
  for (const kind of [0, 3, 9000, 9005, 9021, 30177]) assert.throws(() => plugin.template({ kind, content: "", tags: [] }), /can't publish/);
  assert.throws(() => plugin.template({ kind: 9, content: "", tags: [["h", 1]] }), /tags/);
});

async function until<T>(read: () => T | undefined | false, what: string, context: () => string, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}. Output:\n${context()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
