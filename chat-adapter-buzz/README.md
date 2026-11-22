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
      secretKey: process.env.BUZZ_PRIVATE_KEY,
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
| `secretKey` | `BUZZ_PRIVATE_KEY` | The bot's key: 64 hex characters or `nsec1…` |
| `channels` | `BUZZ_CHANNELS` | Channel ids to listen in, comma-separated in the env. Leave empty to follow the bot's channel memberships, as Buzz agents do |
| `authTag` | `BUZZ_AUTH_TAG` | Optional NIP-OA `["auth", owner, conditions, signature]` tag from the bot's owner, as a JSON array in the env |
| `userName` | | The name people mention, `bot` by default |
| `join` | `BUZZ_JOIN` | Channel ids to join on start when following memberships |
| `profile` | | `{ name, about, picture }` to publish as the bot's profile on start, with its `auth` tag |

The bot's key must be allowed on the relay. Either enroll it as a member of the community and add it to the channels, or give it a NIP-OA tag signed by a member who owns it. Keep the secret key out of the repository.

## Run it as a Buzz agent (Buzz 1.x)

Install the [Chat SDK agents](../chat-sdk-agents) plugin and create an agent with the **Chat SDK** harness. Buzz runs the bot as that agent and keeps the key and the community sign-in, so this works on hosted communities that require NIP-FI. The bot uses `createBuzzAdapter({ host: await connectStdioHost() })`.

## Run it on this computer with its own key

`provider/buzz-backend-chatsdk` gives a bot its own key and runs it as a systemd user service, `buzz-chatsdk-<first 16 hex of the pubkey>`. The key is saved in a 0600 file under `~/.config/buzz-chatsdk/agents` and reaches the bot by path.

```sh
ln -s "$PWD/provider/buzz-backend-chatsdk.sh" ~/.local/bin/buzz-backend-chatsdk
```

### Buzz 1.x, communities without NIP-FI

Hosted communities (`requires_nip_fi` in their relay info, such as `*.communities.buzz.xyz`) refuse a key that has only an ownership proof; use the plugin there.

```sh
buzz-backend-chatsdk new Cards wss://<community relay>   # prints the bot's public key
```

In Buzz, open **Settings → Security → Authorize external identity**, paste the hex public key and copy the ownership proof it signs. Then:

```sh
buzz-backend-chatsdk authorize <agent> '<ownership proof>'   # checks the proof against the bot's key
buzz-backend-chatsdk channels <agent>                        # channels the bot can see
buzz-backend-chatsdk join <agent> <channel id>               # joined on start (kind 9021)
buzz-backend-chatsdk start <agent> [bot script]
```

On start the bot authenticates with the proof, publishes a profile carrying it, so Buzz shows the bot as your agent, and joins its channels. The proof has no time or event-kind limit: anyone holding the bot's key can act as your agent. `remove` deletes the key; revoke the bot in Buzz too.

The bot script defaults to `examples/card-bot.ts`, which answers mentions with a card and thanks people when they use it. It answers only its owner unless its config says `"respond_to": "anyone"`, and stops on its owner's `!shutdown`.

### Buzz Desktop 0.5.x

The same file is a remote-agents provider (protocol v1). Create an agent with **Run on: chatsdk**; the Desktop hands over the agent's key and NIP-OA tag in `deploy`, and the provider starts the bot. Deleting the agent there doesn't stop the service (v1 has no undeploy); run `remove`.

```sh
buzz-backend-chatsdk list
buzz-backend-chatsdk logs <agent> [lines]
buzz-backend-chatsdk stop <agent>
buzz-backend-chatsdk remove <agent>   # also deletes the saved key
```

The service runs on Linux with systemd, while this computer is on.

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

- The bot hears new kind 9 messages in its channels. It doesn't report other people's edits, deletes or reactions, and it doesn't receive files.
- No modals, ephemeral messages or scheduled messages.
- History pages by second, so messages sent in the same second as a page edge can repeat or be skipped.

## Development

```sh
pnpm install
pnpm test    # the adapter under Chat SDK, the provider and the example bot, against an in-memory Buzz-like relay
pnpm build   # writes dist/
```

`src/wire.ts` is a copy of `chat-cards/src/wire.ts`; a test fails if they drift.
