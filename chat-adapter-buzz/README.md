# chat-adapter-buzz

A [Chat SDK](https://chat-sdk.dev) adapter for [Buzz](https://github.com/block/buzz-app). Your bot connects to a Buzz relay, answers mentions, follows threads, and posts cards. People who have the [Chat Cards](../chat-cards) plugin see the cards with their buttons; everyone else sees the Markdown fallback.

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createBuzzAdapter } from "chat-adapter-buzz";

const chat = new Chat({
  userName: "deploybot",
  adapters: {
    buzz: createBuzzAdapter({
      relayUrl: "wss://buzz.example.com",
      secretKey: process.env.BUZZ_SECRET_KEY,
      channels: ["<channel id>"],
    }),
  },
  state: createMemoryState(),
});

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.fullName}!`);
});

chat.onAction("approve", async (event) => {
  await event.thread?.post(`Approved by ${event.user.fullName}`);
});

await chat.initialize();
```

Cards from [json-render](https://json-render.dev) work as they do on Slack and Teams:

```ts
import { streamCard } from "@json-render/chat";

chat.onNewMention(async (thread, message) => {
  const result = streamText({ model, system: catalog.prompt(), prompt: message.text });
  await streamCard(thread, result.textStream);
});
```

The bot keeps a WebSocket open to the relay. It doesn't use webhooks, so run it as a long-lived process rather than a serverless function.

## Configuration

| Option | Env | |
| --- | --- | --- |
| `relayUrl` | `BUZZ_RELAY_URL` | The community's relay, `wss://…` |
| `secretKey` | `BUZZ_SECRET_KEY` | The bot's key: 64 hex characters or `nsec1…` |
| `channels` | `BUZZ_CHANNELS` | Channel ids to listen in, comma-separated in the env |
| `authTag` | `BUZZ_AUTH_TAG` | Optional NIP-OA `["auth", owner, conditions, signature]` tag from the bot's owner, as a JSON array in the env |
| `userName` | | The name people mention, `bot` by default |

The bot's key must be allowed on the relay. Either enroll it as a member of the community and add it to the channels, or give it a NIP-OA tag signed by a member who owns it. Keep the secret key out of the repository.

## How it maps to Buzz

| Chat SDK | Buzz |
| --- | --- |
| Thread id | `buzz:<channel>:<root event id>`. A top-level mention starts a thread rooted at that message |
| `post` | Kind 9 message with `h` (channel), NIP-10 `e` (thread) and `ms` tags |
| `edit` | Kind 40003 edit. Streaming posts once, then edits |
| `delete` | Kind 9005 |
| Reactions | Kind 7, removed with kind 5 |
| `startTyping` | Kind 20002 typing indicator |
| Cards | Markdown fallback plus a `buzz-card` block (see [Chat Cards](../chat-cards#message-format)) |
| `onAction` | A thread reply with a `buzz-card-action` block. It's accepted only when it names a card this bot posted in the same channel |
| `fetchMessages` | Relay query, with each message's latest edit applied and deleted messages left out |
| Mentions | `isMention` comes from the message's `p` tags |

## Limits

- The bot hears new kind 9 messages in its configured channels. It doesn't report other people's edits, deletes or reactions, and it doesn't receive files.
- No modals, ephemeral messages or scheduled messages.
- History pages by second, so messages sent in the same second as a page edge can repeat or be skipped.

## Development

```sh
pnpm install
pnpm test    # runs the adapter with Chat SDK against an in-memory Buzz-like relay
pnpm build   # writes dist/
```

`src/wire.ts` is a copy of `chat-cards/src/wire.ts`; a test fails if they drift.
