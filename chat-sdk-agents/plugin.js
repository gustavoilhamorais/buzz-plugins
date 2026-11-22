// Chat SDK agents: a Buzz 1.x agent type whose agents are Chat SDK bots.
//
// For each running agent of this type the plugin keeps one Node process, the
// bot, and talks to it in JSON lines tagged "buzz":1 (see
// chat-adapter-buzz/src/stdio.ts). Buzz delivers the messages that mention the
// agent to `run`; the plugin passes them on. The bot asks the plugin to publish
// and read, and the plugin does it through the agent's handle, so Buzz signs as
// the agent and adds its community sign-in. No key reaches the bot.

const PROTOCOL = 1;
const TYPE_ID = "chat-sdk";
const PLUGIN_ID = "io.github.gustavoilhamorais.chat-sdk-agents";
/** What the agent's handle may publish: messages, edits, reactions, NIP-09 deletes, typing. */
const KINDS = new Set([5, 7, 9, 20002, 40003]);
const MAX_LINE = 1024 * 1024;
const LOG_LINES = 200;

export const DEFAULT_CONFIG = Object.freeze({
  /** The bot's folder; `~/…` or absolute. */
  cwd: "~/Documents/dev/buzz-plugins/chat-adapter-buzz",
  /** The bot's script, relative to `cwd`. */
  script: "examples/card-bot.ts",
  /** "owner-only" or "anyone". */
  respondTo: "owner-only",
});

export const inject = ["agents", "host"];

export function apply(ctx) {
  const { agents, host } = ctx;
  if (typeof host?.spawn !== "function") return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const bots = new Map();

  const botFor = (agent) => {
    let bot = bots.get(agent.key);
    if (!bot || bot.exited) {
      bot = new Bot(agent, host, agents);
      bots.set(agent.key, bot);
      void bot.start();
    }
    return bot;
  };

  const sync = () => {
    const snapshot = agents.snapshot?.();
    if (!snapshot || snapshot.status === "loading") return;
    const mine = (snapshot.running ?? []).filter((agent) => agent.type === typeKey);
    const keys = new Set(mine.map((agent) => agent.key));
    for (const agent of mine) botFor(agent);
    for (const [key, bot] of bots) {
      if (keys.has(key)) continue;
      bots.delete(key);
      void bot.stop();
    }
  };

  agents.register({
    id: TYPE_ID,
    title: "Chat SDK",
    description: "A Chat SDK bot on this computer. Buzz delivers its mentions and posts its replies and cards.",
    defaults: () => ({ config: { ...DEFAULT_CONFIG } }),
    summary: (agent) => `Chat SDK · ${config(agent.config).script}`,
    run(delivery) {
      const trigger = delivery.trigger;
      if (trigger?.type !== "mention" || !trigger.event) return;
      const agent = delivery.agent;
      botFor({ key: agent.key, pubkey: agent.pubkey, owner: agent.owner, name: agent.name, config: delivery.config }).deliver(trigger.event);
    },
    retire: async (key) => {
      const bot = bots.get(key);
      bots.delete(key);
      await bot?.stop();
    },
  });

  const unsubscribe = agents.subscribe?.(sync);
  sync();
  ctx.effect?.(() => () => {
    unsubscribe?.();
    for (const bot of bots.values()) void bot.stop();
    bots.clear();
  });
}

class Bot {
  constructor(agent, host, agents) {
    this.agent = agent;
    this.host = host;
    this.agents = agents;
    this.process = null;
    this.queue = [];
    this.buffer = "";
    this.exited = false;
    this.stopping = false;
    this.log = [];
  }

  async start() {
    const { cwd, script, respondTo } = config(this.agent.config);
    try {
      this.process = await this.host.spawn("bot", {
        args: [script],
        cwd,
        env: {
          BUZZ_HOST: "stdio",
          BUZZ_RESPOND_TO: respondTo,
          // The AppImage's libraries are for Buzz, not for Node.
          LD_LIBRARY_PATH: null,
          PYTHONHOME: null,
          PYTHONPATH: null,
          GTK_PATH: null,
          GIO_MODULE_DIR: null,
        },
        onStdout: (data) => this.read(data),
        onStderr: (data) => this.remember(data),
      });
    } catch (error) {
      this.exited = true;
      this.remember(`Couldn't start the bot: ${message(error)}`);
      console.error(`[chat-sdk] ${this.agent.name}: couldn't start the bot`, error);
      return;
    }
    void this.process.exited.then((code) => {
      this.exited = true;
      if (!this.stopping) console.warn(`[chat-sdk] ${this.agent.name}: the bot exited (${code})\n${this.log.slice(-20).join("\n")}`);
    });
    const { pubkey, owner, name } = this.agent;
    await this.send({ type: "start", agent: { pubkey, owner, name } });
    for (const item of this.queue.splice(0)) await this.send(item);
  }

  deliver(event) {
    const item = { type: "event", event };
    if (this.process) void this.send(item);
    else this.queue.push(item);
  }

  async stop() {
    this.stopping = true;
    if (!this.process || this.exited) return;
    await this.send({ type: "stop" }).catch(() => undefined);
    const exited = await Promise.race([this.process.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    if (!exited) await this.process.kill();
  }

  async send(body) {
    if (!this.process || this.exited) return;
    await this.process.write(JSON.stringify({ buzz: PROTOCOL, ...body }) + "\n");
  }

  read(data) {
    this.buffer += data;
    if (this.buffer.length > MAX_LINE && !this.buffer.includes("\n")) this.buffer = "";
    let at;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      let request = null;
      try {
        request = line.startsWith("{") ? JSON.parse(line) : null;
      } catch {}
      if (request?.buzz === PROTOCOL && typeof request.id === "number") void this.answer(request);
      else if (line.trim()) this.remember(line);
    }
  }

  async answer(request) {
    try {
      const handle = this.agents.handle(this.agent.key);
      if (!handle) throw new Error("This agent isn't running in this copy of Buzz");
      let value;
      if (request.type === "publish") value = await handle.publish(template(request.template));
      else if (request.type === "query") value = await handle.query(filters(request.filters));
      else throw new Error(`Unknown request ${request.type}`);
      await this.send({ type: "reply", id: request.id, ok: true, value });
    } catch (error) {
      await this.send({ type: "reply", id: request.id, ok: false, error: message(error) });
    }
  }

  remember(text) {
    for (const line of String(text).split("\n")) if (line.trim()) this.log.push(line);
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
  }
}

export function config(saved) {
  const value = saved && typeof saved === "object" ? saved : {};
  const pick = (key) => (typeof value[key] === "string" && value[key].trim() ? value[key].trim() : DEFAULT_CONFIG[key]);
  return { cwd: pick("cwd"), script: pick("script"), respondTo: pick("respondTo") === "anyone" ? "anyone" : "owner-only" };
}

/** Only the kinds a Chat SDK bot needs, with string tags. */
export function template(value) {
  if (!value || typeof value !== "object") throw new Error("No event to publish");
  const { kind, content, tags } = value;
  if (!KINDS.has(kind)) throw new Error(`Chat SDK bots can't publish kind ${kind}`);
  if (typeof content !== "string") throw new Error("Event content must be text");
  if (!Array.isArray(tags) || !tags.every((tag) => Array.isArray(tag) && tag.length > 0 && tag.every((part) => typeof part === "string")))
    throw new Error("Event tags must be arrays of text");
  return { kind, content, tags };
}

export function filters(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10 || !value.every((f) => f && typeof f === "object" && !Array.isArray(f)))
    throw new Error("Queries take 1 to 10 filters");
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
