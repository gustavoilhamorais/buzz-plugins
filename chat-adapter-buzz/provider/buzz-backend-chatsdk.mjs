#!/usr/bin/env node
// Runs Chat SDK bots with chat-adapter-buzz on this computer as systemd user services.
//
// Buzz 1.x: `new` makes the bot's key here; its owner authorizes the public key in
//   Buzz → Settings → Security → Authorize external identity and gives the proof to
//   `authorize`. Then `channels`, `join` and `start`.
// Buzz Desktop 0.5.x: remote-agents protocol v1 (`info` and `deploy`), one JSON
//   request on stdin and one JSON response on stdout, with "Run on: chatsdk".
//
// The identity lives in a 0600 file under $XDG_CONFIG_HOME/buzz-chatsdk/agents and
// reaches the bot by path, never in argv, the unit's environment or a log line.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { decode, nsecEncode, npubEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

const VERSION = "0.1.0";
const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = process.env.BUZZ_CHATSDK_STATE_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "buzz-chatsdk");
const AGENTS = join(STATE, "agents");
const NODE = process.env.BUZZ_CHATSDK_NODE ?? process.execPath;
const DRY_RUN = process.env.BUZZ_CHATSDK_DRY_RUN === "1";
const DEFAULT_ENTRY = join(PACKAGE, "examples", "card-bot.ts");

class Refusal extends Error {}

const unitOf = (hex) => `buzz-chatsdk-${hex.slice(0, 16)}`;

function info() {
  return {
    ok: true,
    name: "Chat SDK bot (this computer)",
    version: VERSION,
    protocol_version: 1,
    description: "Runs a Chat SDK bot with chat-adapter-buzz as a systemd user service on this computer.",
    config_schema: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          title: "Bot script",
          description: "Absolute path of the bot's .ts or .js file",
          default: DEFAULT_ENTRY,
        },
      },
    },
  };
}

function deploy(agent, providerConfig) {
  if (!agent || typeof agent !== "object") throw new Refusal("deploy refused: no agent payload");
  const nsec = agent.private_key_nsec;
  if (typeof nsec !== "string" || !nsec.startsWith("nsec1")) throw new Refusal("deploy refused: the agent has no private key");
  if (typeof agent.relay_url !== "string" || !/^wss?:\/\//.test(agent.relay_url)) throw new Refusal("deploy refused: relay_url must be a ws:// or wss:// URL");
  const decoded = decode(nsec);
  if (decoded.type !== "nsec") throw new Refusal("deploy refused: private_key_nsec is not an nsec");
  const pubkey = getPublicKey(decoded.data);

  const entry = typeof providerConfig?.entry === "string" && providerConfig.entry.trim() ? providerConfig.entry.trim() : DEFAULT_ENTRY;
  if (!isAbsolute(entry) || !existsSync(entry) || !statSync(entry).isFile()) throw new Refusal(`deploy refused: bot script not found at ${entry}`);

  const config = {
    name: agent.name,
    relay_url: agent.relay_url,
    private_key_nsec: nsec,
    ...(typeof agent.auth_tag === "string" && agent.auth_tag ? { auth_tag: agent.auth_tag } : {}),
    ...(agent.respond_to ? { respond_to: agent.respond_to } : {}),
    ...(Array.isArray(agent.respond_to_allowlist) ? { respond_to_allowlist: agent.respond_to_allowlist } : {}),
  };
  const file = save(pubkey, config);
  const unit = unitOf(pubkey);
  if (!DRY_RUN) start(unit, entry, file);
  return { ok: true, agent_id: unit };
}

function save(pubkey, config) {
  mkdirSync(AGENTS, { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  chmodSync(AGENTS, 0o700);
  const file = join(AGENTS, `${pubkey.slice(0, 16)}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function load(hex) {
  const file = join(AGENTS, `${hex}.json`);
  if (!existsSync(file)) throw new Refusal(`no saved agent ${hex}; see \`buzz-backend-chatsdk list\``);
  const config = JSON.parse(readFileSync(file, "utf8"));
  return { file, config, pubkey: getPublicKey(decode(config.private_key_nsec).data) };
}

/** Checks a NIP-OA proof: ["auth", owner, conditions, sig over sha256("nostr:agent-auth:" + agent + ":" + conditions)]. */
export function checkProof(proof, agent) {
  let tag;
  try {
    tag = typeof proof === "string" ? JSON.parse(proof) : proof;
  } catch {
    throw new Refusal("the ownership proof is not JSON; paste it exactly as Buzz shows it");
  }
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== "auth" || !/^[0-9a-f]{64}$/.test(tag[1]) || typeof tag[2] !== "string" || !/^[0-9a-f]{128}$/.test(tag[3]))
    throw new Refusal('the ownership proof must look like ["auth","<owner hex>","","<signature>"]');
  if (tag[1] === agent) throw new Refusal("the proof's owner is the bot itself");
  const digest = sha256(utf8ToBytes(`nostr:agent-auth:${agent}:${tag[2]}`));
  if (!schnorr.verify(hexToBytes(tag[3]), digest, hexToBytes(tag[1])))
    throw new Refusal("the ownership proof was signed for a different public key; authorize this bot's key in Buzz");
  return tag;
}

async function withAdapter(config, run) {
  const { createBuzzAdapter } = await import("../src/index.ts");
  const adapter = createBuzzAdapter({
    relayUrl: config.relay_url,
    secretKey: config.private_key_nsec,
    ...(config.auth_tag ? { authTag: JSON.parse(config.auth_tag) } : {}),
  });
  try {
    await adapter.connect();
    return await run(adapter);
  } finally {
    await adapter.disconnect();
  }
}

/** Deploy is an upsert: replace any running copy, then start and confirm it stays up. */
function start(unit, entry, file) {
  systemctl(["stop", unit], true);
  systemctl(["reset-failed", unit], true);
  const run = spawnSync("systemd-run", [
    "--user",
    `--unit=${unit}`,
    `--description=Buzz Chat SDK bot ${unit}`,
    "--property=Restart=on-failure",
    "--property=RestartSec=5",
    `--working-directory=${PACKAGE}`,
    `--setenv=BUZZ_AGENT_CONFIG=${file}`,
    NODE,
    entry,
  ], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`systemd-run failed: ${run.stderr.trim()}`);
  // A bad key or a refused AUTH ends the process within a few seconds.
  execFileSync("sleep", ["4"]);
  const state = systemctl(["is-active", unit], true).trim();
  if (state !== "active") throw new Error(`the bot did not stay up (${state}):\n${journal(unit, 20)}`);
}

function systemctl(args, quiet = false) {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.status !== 0 && !quiet) throw new Error(result.stderr.trim());
  return result.stdout ?? "";
}

function journal(unit, lines) {
  return spawnSync("journalctl", ["--user", "-u", unit, "-n", String(lines), "--no-pager", "-o", "cat"], { encoding: "utf8" }).stdout ?? "";
}

function target(arg) {
  if (!arg) throw new Refusal("name an agent: its pubkey (hex), the first 16 hex characters, or buzz-chatsdk-<hex16>");
  const hex = arg.replace(/^buzz-chatsdk-/, "").toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(hex)) throw new Refusal(`not an agent: ${arg}`);
  return hex.slice(0, 16);
}

async function human(op, args) {
  switch (op) {
    case "new": {
      const [name, relay] = args;
      if (!name || !/^wss?:\/\//.test(relay ?? "")) throw new Refusal("usage: buzz-backend-chatsdk new <name> <wss://relay>");
      const key = generateSecretKey();
      const pubkey = getPublicKey(key);
      save(pubkey, { name, relay_url: relay, private_key_nsec: nsecEncode(key), respond_to: "owner-only", publish_profile: true });
      return [
        `Made ${name}: ${unitOf(pubkey)}`,
        `Public key (hex): ${pubkey}`,
        `npub: ${npubEncode(pubkey)}`,
        "",
        "In Buzz: Settings → Security → Authorize external identity, paste the hex key, then run",
        `  buzz-backend-chatsdk authorize ${pubkey.slice(0, 16)} '<ownership proof>'`,
      ].join("\n");
    }
    case "authorize": {
      const { config, pubkey } = load(target(args[0]));
      const tag = checkProof(args[1], pubkey);
      save(pubkey, { ...config, auth_tag: JSON.stringify(tag) });
      return `Authorized by ${tag[1]}. Next: buzz-backend-chatsdk channels ${pubkey.slice(0, 16)}`;
    }
    case "channels": {
      const { config } = load(target(args[0]));
      const channels = await withAdapter(config, (adapter) => adapter.listChannels());
      const joining = new Set(config.join ?? []);
      return channels.map((c) => `${c.id}\t${c.member ? "member" : joining.has(c.id) ? "joins on start" : "-"}\t${c.name}`).join("\n") || "no channels visible";
    }
    case "join": {
      const { config, pubkey } = load(target(args[0]));
      const wanted = args.slice(1);
      if (!wanted.length || wanted.some((c) => !/^[A-Za-z0-9_-]{1,128}$/.test(c))) throw new Refusal("usage: buzz-backend-chatsdk join <agent> <channel id>...");
      save(pubkey, { ...config, join: [...new Set([...(config.join ?? []), ...wanted])] });
      return `${pubkey.slice(0, 16)} joins ${wanted.join(", ")} on start`;
    }
    case "start": {
      const { file, config, pubkey } = load(target(args[0]));
      if (!config.auth_tag) throw new Refusal(`authorize the bot first: buzz-backend-chatsdk authorize ${pubkey.slice(0, 16)} '<ownership proof>'`);
      const entry = args[1] ? resolve(args[1]) : DEFAULT_ENTRY;
      if (!existsSync(entry)) throw new Refusal(`bot script not found at ${entry}`);
      start(unitOf(pubkey), entry, file);
      return `${unitOf(pubkey)} is running. Logs: buzz-backend-chatsdk logs ${pubkey.slice(0, 16)}`;
    }
    case "list":
      if (!existsSync(AGENTS)) return "no agents";
      return readdirSync(AGENTS).filter((f) => f.endsWith(".json")).map((f) => {
        const { config } = load(f.slice(0, 16));
        const unit = unitOf(f.slice(0, 16));
        return `${f.slice(0, 16)}\t${config.name ?? ""}\t${config.auth_tag ? "authorized" : "not authorized"}\t${systemctl(["is-active", unit], true).trim()}`;
      }).join("\n") || "no agents";
    case "status":
      return systemctl(["status", unitOf(target(args[0])), "--no-pager"], true);
    case "logs":
      return journal(unitOf(target(args[0])), Number(args[1] ?? 50));
    case "stop":
      systemctl(["stop", unitOf(target(args[0]))], true);
      return "stopped";
    case "remove": {
      const hex = target(args[0]);
      systemctl(["stop", unitOf(hex)], true);
      rmSync(join(AGENTS, `${hex}.json`), { force: true });
      return "stopped and removed the saved identity";
    }
    default:
      return [
        "usage: buzz-backend-chatsdk <command>",
        "  new <name> <wss://relay>      make a bot key",
        "  authorize <agent> '<proof>'   save the ownership proof from Buzz → Settings → Security",
        "  channels <agent>              channels the bot can see",
        "  join <agent> <channel id>...  channels to join on start",
        "  start <agent> [bot script]    run it as a systemd user service",
        "  list | status | logs <agent> [lines] | stop <agent> | remove <agent>",
      ].join("\n");
  }
}

async function main() {
  if (process.argv.length > 2 || process.stdin.isTTY) {
    try {
      console.log(await human(process.argv[2], process.argv.slice(3)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let response;
  try {
    const request = JSON.parse(input);
    if (request.op === "info") response = info();
    else if (request.op === "deploy") response = deploy(request.agent, request.provider_config ?? {});
    else response = { ok: false, error: `unsupported op: ${request.op}` };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(response) + "\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
