# Chat SDK agents

A Buzz 1.x plugin that adds a **Chat SDK** agent type. Each agent of this type is a [Chat SDK](https://chat-sdk.dev) bot that runs on this computer, built with [chat-adapter-buzz](../chat-adapter-buzz).

Buzz keeps the agent's key and its community sign-in, including NIP-FI on hosted communities such as `*.communities.buzz.xyz`. The bot never sees either:

- Buzz delivers each message that mentions the agent. The plugin passes it to the bot.
- The bot asks the plugin to publish or read. The plugin does it through the agent's handle, so Buzz signs as the agent.

## Install

1. In Buzz, open **Settings → Plugins → Manage plugins → Add**. Choose **Browse** under *Add from folder* and pick this folder.
2. Review the host access. The plugin starts `node`, which it needs to run the bot. Then install.
3. Create an agent and choose **Chat SDK** as its harness. Add it to a channel and mention it.

The bot is `examples/card-bot.ts` in `~/Documents/dev/buzz-plugins/chat-adapter-buzz` by default. It answers its owner with a card, and the card's buttons edit it. The agent's config keys are:

| Key | Default | |
| --- | --- | --- |
| `cwd` | `~/Documents/dev/buzz-plugins/chat-adapter-buzz` | The bot's folder |
| `script` | `examples/card-bot.ts` | The bot's script, relative to `cwd` |
| `respondTo` | `owner-only` | `anyone` to answer everyone Buzz delivers |

Node 24 or later must be on Buzz's `PATH` (`~/.local/bin` counts).

## Writing a bot

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createBuzzAdapter } from "chat-adapter-buzz";
import { connectStdioHost } from "chat-adapter-buzz/stdio";

const host = await connectStdioHost();
const chat = new Chat({
  userName: host.name ?? "bot",
  adapters: { buzz: createBuzzAdapter({ host }) },
  state: createMemoryState(),
});
chat.onNewMention((thread, message) => thread.post(`Oi, ${message.author.fullName}!`));
await chat.initialize();
host.onStop(() => void chat.shutdown().finally(() => process.exit(0)));
```

## Limits

- The bot gets only the messages Buzz delivers to the agent: mentions, and card choices, which mention it. It doesn't see other messages in a thread.
- It may publish messages, edits, reactions, NIP-09 deletes and typing (kinds 9, 40003, 7, 5 and 20002). The plugin refuses every other kind.
- The bot runs while Buzz runs the agent on this computer. It starts when the plugin loads, and again with the next mention after it exits.
- No Windows: Buzz has no process transport there.

## Protocol

JSON lines tagged `"buzz":1` on the bot's stdin and stdout. Other stdout lines are logs. See [`src/stdio.ts`](../chat-adapter-buzz/src/stdio.ts).
