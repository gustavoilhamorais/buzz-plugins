import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { nsecEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayClient } from "../src/relay.ts";
import { formatAction, parseCardMessage } from "../src/wire.ts";
import { MockRelay } from "./mock-relay.ts";

const provider = new URL("../provider/buzz-backend-chatsdk.mjs", import.meta.url).pathname;
const bot = new URL("../examples/card-bot.ts", import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), "buzz-chatsdk-"));
after(() => rmSync(state, { recursive: true, force: true }));

function call(request: unknown) {
  const run = spawnSync(process.execPath, [provider], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { ...process.env, BUZZ_CHATSDK_STATE_DIR: state, BUZZ_CHATSDK_DRY_RUN: "1" },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

/** Runs the CLI without blocking this process, which serves the mock relay. */
function cli(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const child = spawn(process.execPath, [provider, ...args], { env: { ...process.env, BUZZ_CHATSDK_STATE_DIR: state }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => child.kill(), 15_000);
  return new Promise((resolve) => child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
  }));
}

/** What Buzz → Settings → Security → Authorize external identity returns. */
function ownershipProof(ownerKey: Uint8Array, agent: string): string[] {
  const sig = schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${agent}:`)), ownerKey);
  return ["auth", getPublicKey(ownerKey), "", bytesToHex(sig)];
}

test("info declares protocol 1 and the bot script setting", () => {
  const info = call({ op: "info", request_id: "1" });
  assert.equal(info.ok, true);
  assert.equal(info.protocol_version, 1);
  assert.equal((info.config_schema as { properties: { entry: { default: string } } }).properties.entry.default, bot);
});

test("deploy saves the identity privately and names the unit by pubkey", () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const agent = { name: "Cards", relay_url: "wss://relay.example", private_key_nsec: nsecEncode(key), auth_tag: '["auth","a","","b"]', respond_to: "owner-only" };
  const result = call({ op: "deploy", request_id: "2", agent, provider_config: {} });
  assert.deepEqual(result, { ok: true, agent_id: `buzz-chatsdk-${pubkey.slice(0, 16)}` });
  const file = join(state, "agents", `${pubkey.slice(0, 16)}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(state, "agents")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), agent);
});

test("deploy refuses an agent without a key or with a missing script", () => {
  const nokey = call({ op: "deploy", agent: { relay_url: "wss://r" }, provider_config: {} });
  assert.equal(nokey.ok, false);
  assert.match(String(nokey.error), /no private key/);
  const agent = { relay_url: "wss://r", private_key_nsec: nsecEncode(generateSecretKey()) };
  const missing = call({ op: "deploy", agent, provider_config: { entry: "/nonexistent/bot.ts" } });
  assert.match(String(missing.error), /bot script not found/);
});

test("the example bot answers a mention with a card, thanks a choice, and stops on the owner's !shutdown", async () => {
  const relay = await MockRelay.start();
  const botKey = generateSecretKey();
  const ownerKey = generateSecretKey();
  const botPubkey = getPublicKey(botKey);
  const owner = getPublicKey(ownerKey);
  const channel = "cards-e2e";
  relay.inject(finalizeEvent({ kind: 39002, content: "", tags: [["d", channel], ["p", botPubkey], ["p", owner]], created_at: Math.floor(Date.now() / 1000) }, generateSecretKey()));

  const child: ChildProcess = spawn(process.execPath, [bot], {
    env: {
      ...process.env,
      BUZZ_RELAY_URL: relay.url,
      BUZZ_PRIVATE_KEY: nsecEncode(botKey),
      BUZZ_AUTH_TAG: JSON.stringify(["auth", owner, "", "0".repeat(128)]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const person = new RelayClient({ url: relay.url, sign: (t) => finalizeEvent(t, ownerKey), timeoutMs: 3000 });
  try {
    await until(() => output.includes("is listening"), "the bot to start", () => output);
    await person.connect();
    const say = async (content: string, root?: string) => {
      const tags = [["h", channel], ["p", botPubkey]];
      if (root) tags.push(["e", root, "", "reply"]);
      const event = finalizeEvent({ kind: 9, content, tags, created_at: Math.floor(Date.now() / 1000) }, ownerKey);
      await person.publish(event);
      return event;
    };

    const ask = await say("@Cards oi tudo bem");
    const card = await until(() => relay.events.find((e) => e.pubkey === botPubkey && e.kind === 9), "the card", () => output);
    const parsed = parseCardMessage(card.content);
    assert.equal(parsed?.status, "ok");
    assert.match(card.content, /oi tudo bem/);

    await say(formatAction({ message: card.id, action: "feedback", value: "up", values: { comment: "ótimo" } }, "Útil"), ask.id);
    const thanks = await until(() => relay.events.find((e) => e.pubkey === botPubkey && e.kind === 40003), "the thank-you edit", () => output);
    assert.ok(thanks.tags.some((t) => t[0] === "e" && t[1] === card.id));
    assert.match(thanks.content, /achou útil/);
    assert.match(thanks.content, /ótimo/);

    await say("@Cards !shutdown");
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]), 0);
  } finally {
    person.close();
    child.kill();
    await relay.stop();
  }
});

test("Buzz 1.x: a bot with its own key, authorized by its owner, announces itself, joins a channel and answers", async () => {
  const relay = await MockRelay.start();
  const ownerKey = generateSecretKey();
  const channel = "general-1x";
  relay.inject(finalizeEvent({ kind: 39000, content: "", tags: [["d", channel], ["name", "general"]], created_at: Math.floor(Date.now() / 1000) }, generateSecretKey()));

  const made = await cli("new", "Cards", relay.url);
  assert.ok(made.ok, made.err);
  const pubkey = /Public key \(hex\): ([0-9a-f]{64})/.exec(made.out)?.[1];
  assert.ok(pubkey, made.out);
  const agent = pubkey.slice(0, 16);

  assert.match((await cli("start", agent)).err, /authorize the bot first/);
  assert.match((await cli("authorize", agent, JSON.stringify(ownershipProof(ownerKey, getPublicKey(generateSecretKey()))))).err, /different public key/);
  const proof = ownershipProof(ownerKey, pubkey);
  assert.ok((await cli("authorize", agent, JSON.stringify(proof))).ok);
  assert.match((await cli("list")).out, new RegExp(`${agent}\\tCards\\tauthorized`));

  const listed = await cli("channels", agent);
  assert.ok(listed.ok, listed.err);
  assert.equal(listed.out, `${channel}\t-\tgeneral`);
  assert.ok((await cli("join", agent, channel)).ok);
  assert.equal((await cli("channels", agent)).out, `${channel}\tjoins on start\tgeneral`);

  const config = join(state, "agents", `${agent}.json`);
  const child: ChildProcess = spawn(process.execPath, [bot], { env: { ...process.env, BUZZ_AGENT_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const person = new RelayClient({ url: relay.url, sign: (t) => finalizeEvent(t, ownerKey), timeoutMs: 3000 });
  try {
    await until(() => output.includes("is listening"), "the bot to start", () => output);
    assert.deepEqual(relay.auths.find((e) => e.pubkey === pubkey)?.tags.find((t) => t[0] === "auth"), proof);
    const profile = relay.events.find((e) => e.pubkey === pubkey && e.kind === 0);
    assert.deepEqual(profile?.tags, [proof]);
    assert.equal(JSON.parse(profile!.content).name, "Cards");
    assert.ok(relay.events.some((e) => e.pubkey === pubkey && e.kind === 9021 && e.tags.some((t) => t[0] === "h" && t[1] === channel)));

    await person.connect();
    await person.publish(finalizeEvent({ kind: 9, content: "@Cards oi", tags: [["h", channel], ["p", pubkey]], created_at: Math.floor(Date.now() / 1000) }, ownerKey));
    const card = await until(() => relay.events.find((e) => e.pubkey === pubkey && e.kind === 9), "the card", () => output);
    assert.equal(parseCardMessage(card.content)?.status, "ok");
  } finally {
    person.close();
    child.kill();
    await relay.stop();
  }
});

async function until<T>(read: () => T | undefined | false, what: string, context: () => string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}. Output:\n${context()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
