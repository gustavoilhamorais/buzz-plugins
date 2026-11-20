# Chat Cards

A Buzz plugin that shows agent cards in messages: text, fields, tables, charts, images (as links), dividers, buttons, selects and text inputs. Cards use the [Chat SDK](https://chat-sdk.dev) card format, so a bot that already renders [json-render](https://json-render.dev) specs or Chat SDK cards on Slack or Teams can post the same card to Buzz.

People without the plugin see the message's Markdown fallback.

## Message format

A card message is Markdown followed by one fenced `buzz-card` block. The block holds `{"v":1,"card":<CardElement>}`, where `card` is the Chat SDK `CardElement` (the value `toCard(spec)` from `@json-render/chat` returns).

````md
Weekly report: revenue R$ 120k, 312 orders.

```buzz-card
{"v":1,"card":{"type":"card","title":"Weekly report","children":[
  {"type":"fields","children":[{"type":"field","label":"Revenue","value":"R$ 120k"}]},
  {"type":"actions","children":[{"type":"button","id":"approve","label":"Approve","style":"primary","value":"w47"}]}
]}}
```
````

The plugin hides the text before the block, because that text is the fallback, and shows any text after it. Edit the message to update the card. Each edit replaces the whole card, so streaming works the same way as on other Chat SDK platforms.

### Choices

When someone clicks a button or picks an option, the plugin posts a reply in the card's thread that mentions the card's author. Text inputs have no button of their own: as in Chat SDK, what people typed goes along with the action as `values`.

````md
Approve

```buzz-card-action
{"v":1,"message":"<card message id>","action":"approve","value":"w47","values":{"note":"ship it"}}
```
````

The bot treats that reply as the action: `action` is the element `id`, `value` is the button value or the chosen option, and `values` holds the card's text inputs by id. [chat-adapter-buzz](../chat-adapter-buzz) turns it into a Chat SDK `onAction` event. The plugin shows the reply as "Chose **Approve**". A choice is an ordinary signed message from the person who made it, so check that they're allowed to take that action.

### Limits

- Only `http` and `https` URLs without credentials are shown. Images stay links, because loading a remote image would reveal the reader to that host.
- At most 1000 elements, 8 levels of nesting, and 256 KB per message. Unknown element types are skipped, so newer cards still show on older plugins.
- `src/wire.ts` holds the parser and `formatCardMessage`/`formatAction`. The adapter keeps an identical copy.

## Build and test

Node 24 and pnpm:

```sh
pnpm install
pnpm test    # wire format, json-render compatibility, render smoke test
pnpm build   # writes plugin.js; commit it
```

## Try it

1. In Buzz 1.0 or later, open **Settings → Plugins → Load from folder**, choose this folder, then install and enable it.
2. Post the example above, or `examples/weekly-report.md`, in a channel.
