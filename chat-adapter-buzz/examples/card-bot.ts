// A Buzz agent that answers mentions with a card and updates the card when
// someone uses it. Run it from the chatsdk provider, or by hand with:
//
//   BUZZ_RELAY_URL=wss://… BUZZ_PRIVATE_KEY=nsec1… BUZZ_AUTH_TAG='["auth",…]' node examples/card-bot.ts
//
// With BUZZ_AGENT_CONFIG set, it reads the identity the provider saved instead.

import { readFileSync } from "node:fs";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type Thread } from "chat";
import { createBuzzAdapter } from "../src/index.ts";

type AgentConfig = {
  name?: string;
  relay_url: string;
  private_key_nsec: string;
  auth_tag?: string;
  respond_to?: "anyone" | "owner-only" | "allowlist";
  respond_to_allowlist?: string[];
  /** Channel ids to join on start. */
  join?: string[];
  /** Set for a bot with its own key (Buzz 1.x), which has no profile until it publishes one. */
  publish_profile?: boolean;
};

const config: AgentConfig = process.env.BUZZ_AGENT_CONFIG
  ? (JSON.parse(readFileSync(process.env.BUZZ_AGENT_CONFIG, "utf8")) as AgentConfig)
  : {
      relay_url: process.env.BUZZ_RELAY_URL ?? "",
      private_key_nsec: process.env.BUZZ_PRIVATE_KEY ?? "",
      ...(process.env.BUZZ_AUTH_TAG ? { auth_tag: process.env.BUZZ_AUTH_TAG } : {}),
    };
const name = config.name ?? "Cards";

const adapter = createBuzzAdapter({
  relayUrl: config.relay_url,
  secretKey: config.private_key_nsec,
  ...(config.auth_tag ? { authTag: JSON.parse(config.auth_tag) as string[] } : {}),
  userName: name,
  ...(config.join?.length ? { join: config.join } : {}),
  ...(config.publish_profile ? { profile: { name, about: "Responde menções com um card do Chat SDK." } } : {}),
});
const owner = adapter.ownerPubkey;

const chat = new Chat({ userName: name, adapters: { buzz: adapter }, state: createMemoryState(), logger: "info" });

/** Honors the agent's "Respond to" setting from Buzz Desktop. */
function allowed(pubkey: string): boolean {
  if (pubkey === owner) return true;
  if (config.respond_to === "owner-only") return false;
  if (config.respond_to === "allowlist") return config.respond_to_allowlist?.includes(pubkey) ?? false;
  return true;
}

async function answer(thread: Thread, message: Message): Promise<void> {
  if (!allowed(message.author.userId)) return;
  // Buzz Desktop stops a remote agent by sending its owner's `!shutdown`.
  if (message.author.userId === owner && /(^|\s)!shutdown\s*$/.test(message.text)) {
    console.log("Shutdown requested by the owner");
    await chat.shutdown();
    process.exit(0);
  }
  await thread.subscribe();
  const asked = message.text.replace(/@\S+/g, "").trim() || "(sem texto)";
  await thread.post({
    type: "card",
    title: `Oi, ${message.author.fullName}`,
    subtitle: "Card enviado pelo Chat SDK",
    children: [
      { type: "text", content: `Você escreveu: **${asked}**` },
      {
        type: "fields",
        children: [
          { type: "field", label: "Palavras", value: String(asked.split(/\s+/).length) },
          { type: "field", label: "Hora", value: new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }) },
        ],
      },
      {
        type: "chart",
        title: "Letras por palavra",
        chart: {
          type: "bar",
          categories: asked.split(/\s+/).slice(0, 8).map((w, i) => `${i + 1}. ${w.slice(0, 10)}`),
          series: [{ name: "Letras", data: asked.split(/\s+/).slice(0, 8).map((w, i) => ({ label: `${i + 1}. ${w.slice(0, 10)}`, value: w.length })) }],
        },
      },
      { type: "text_input", id: "comment", label: "Comentário (opcional)" },
      {
        type: "actions",
        children: [
          { type: "button", id: "feedback", label: "Útil", style: "primary", value: "up" },
          { type: "button", id: "feedback", label: "Não ajudou", value: "down" },
        ],
      },
    ],
  });
}

chat.onNewMention(answer);
chat.onSubscribedMessage(async (thread, message) => {
  if (message.isMention) await answer(thread, message);
});

chat.onAction("feedback", async (event) => {
  if (!allowed(event.user.userId)) return;
  const verdict = event.value === "up" ? "achou útil 👍" : "achou que não ajudou 👎";
  const comment = event.values?.comment?.trim();
  // Replace the card so its buttons can't be used twice.
  await adapter.editMessage(event.threadId, event.messageId, {
    type: "card",
    title: "Obrigado!",
    children: [
      { type: "text", content: `**${event.user.fullName}** ${verdict}.` },
      ...(comment ? [{ type: "text" as const, content: `“${comment}”`, style: "muted" as const }] : []),
    ],
  });
});

await chat.initialize();
console.log(`${name} is listening as ${adapter.botUserId} in ${adapter.listening.length} channel(s)`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void chat.shutdown().finally(() => process.exit(0)));
