#!/usr/bin/env node
// Buzz Desktop provider (remote-agents protocol v1: `info` and `deploy`) that
// runs a Chat SDK bot on this computer as a systemd user service.
//
// Desktop: one JSON request on stdin, one JSON response on stdout.
// People:  buzz-backend-chatsdk list | status <agent> | logs <agent> [lines] | stop <agent> | remove <agent>
//
// The agent's identity arrives only in `deploy`. It's saved in a 0600 file under
// $XDG_CONFIG_HOME/buzz-chatsdk/agents and handed to the bot by path, never in
// argv, the unit's environment or a log line.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

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
  mkdirSync(AGENTS, { recursive: true, mode: 0o700 });
  chmodSync(STATE, 0o700);
  chmodSync(AGENTS, 0o700);
  const file = join(AGENTS, `${pubkey.slice(0, 16)}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);

  const unit = unitOf(pubkey);
  if (!DRY_RUN) start(unit, entry, file);
  return { ok: true, agent_id: unit };
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

function human(op, args) {
  switch (op) {
    case "list":
      if (!existsSync(AGENTS)) return "no agents";
      return readdirSync(AGENTS).filter((f) => f.endsWith(".json")).map((f) => {
        const unit = unitOf(f.slice(0, 16));
        return `${unit}\t${systemctl(["is-active", unit], true).trim()}`;
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
      return "usage: buzz-backend-chatsdk list | status <agent> | logs <agent> [lines] | stop <agent> | remove <agent>";
  }
}

async function main() {
  if (process.argv.length > 2 || process.stdin.isTTY) {
    console.log(human(process.argv[2], process.argv.slice(3)));
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

await main();
