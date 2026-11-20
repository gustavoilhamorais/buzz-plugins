// Wire format shared by Buzz messages and this plugin. A card message is
// ordinary Markdown (read by clients without the plugin) followed by one
// fenced block:
//
//   ```buzz-card
//   {"v":1,"card":{"type":"card", ...}}
//   ```
//
// `card` is a Chat SDK `CardElement`, the value an adapter receives from
// `thread.post(card)` or from json-render's `toCard`. A click is a thread reply
// carrying a `buzz-card-action` block that names the card message.
//
// Everything here reads untrusted relay content: parse defensively, bound the
// work, and drop what is not understood rather than failing the whole card.

export const CARD_LANG = "buzz-card";
export const ACTION_LANG = "buzz-card-action";
export const WIRE_VERSION = 1;

const MAX_CONTENT = 256 * 1024;
const MAX_ELEMENTS = 1000;
const MAX_DEPTH = 8;
const MAX_STRING = 8000;

export type ButtonStyle = "primary" | "danger" | "default";
export type SelectOption = { label: string; value: string; description?: string };
export type Button = { type: "button"; id: string; label: string; style?: ButtonStyle; value?: string; disabled?: boolean };
export type LinkButton = { type: "link-button"; label: string; url: string; style?: ButtonStyle };
export type Select = { type: "select" | "radio_select"; id: string; label: string; options: SelectOption[]; initialOption?: string; placeholder?: string };
export type ActionChild = Button | LinkButton | Select;
export type Field = { type: "field"; label: string; value: string };
export type Chart =
  | { type: "pie"; segments: { label: string; value: number }[] }
  | { type: "bar" | "line" | "area"; categories: string[]; series: { name: string; data: { label: string; value: number }[] }[]; xLabel?: string; yLabel?: string };
export type CardChild =
  | { type: "text"; content: string; style?: "plain" | "bold" | "muted" }
  | { type: "image"; url: string; alt?: string }
  | { type: "divider" }
  | { type: "link"; label: string; url: string }
  | { type: "actions"; children: ActionChild[] }
  | { type: "section"; children: CardChild[] }
  | { type: "fields"; children: Field[] }
  | { type: "table"; headers: string[]; rows: string[][]; align?: ("left" | "center" | "right")[]; caption?: string }
  | { type: "chart"; title: string; chart: Chart }
  | { type: "text_input"; id: string; label: string; placeholder?: string; multiline?: boolean; initialValue?: string };
export type Card = { type: "card"; title?: string; subtitle?: string; imageUrl?: string; children: CardChild[] };

/** `values` carries the card's text inputs when the action fired, keyed by input id. */
export type CardAction = { v: 1; message: string; action: string; value?: string; values?: Record<string, string> };

export type ParsedCard =
  | { status: "ok"; card: Card; before: string; after: string }
  | { status: "invalid"; reason: string; before: string; after: string };

/** Finds the first fenced block whose info string is exactly `lang`. */
export function findBlock(content: string, lang: string): { before: string; body: string; after: string } | null {
  if (content.length > MAX_CONTENT) return null;
  const open = new RegExp("(^|\\n)(`{3,}|~{3,})[ \\t]*" + lang + "[ \\t]*\\r?\\n");
  const start = open.exec(content);
  if (!start) return null;
  const fence = start[2]!;
  const bodyStart = start.index + start[0].length;
  const close = new RegExp("\\n" + fence[0] + "{" + fence.length + ",}[ \\t]*(\\r?\\n|$)", "g");
  close.lastIndex = bodyStart - 1;
  const end = close.exec(content);
  // An unclosed fence runs to the end of the message, as in CommonMark.
  const bodyEnd = end ? end.index : content.length;
  return {
    before: content.slice(0, start.index).trim(),
    body: content.slice(bodyStart, bodyEnd),
    after: end ? content.slice(end.index + end[0].length).trim() : "",
  };
}

export function hasCard(content: string): boolean {
  return content.includes(CARD_LANG) && findBlock(content, CARD_LANG) !== null;
}

export function parseCardMessage(content: string): ParsedCard | null {
  const block = findBlock(content, CARD_LANG);
  if (!block) return null;
  const { before, after } = block;
  let envelope: unknown;
  try {
    envelope = JSON.parse(block.body);
  } catch {
    return { status: "invalid", reason: "The card is not valid JSON.", before, after };
  }
  if (!isRecord(envelope) || envelope.v !== WIRE_VERSION)
    return { status: "invalid", reason: `Unsupported card version; this plugin reads version ${WIRE_VERSION}.`, before, after };
  try {
    return { status: "ok", card: readCard(envelope.card), before, after };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error), before, after };
  }
}

/** Builds the message an adapter posts: readable Markdown, then the card. */
export function formatCardMessage(card: Card, fallback: string): string {
  const json = JSON.stringify({ v: WIRE_VERSION, card });
  return `${fallback.trim()}\n\n\`\`\`${CARD_LANG}\n${json}\n\`\`\``.trimStart();
}

export function formatAction(action: Omit<CardAction, "v">, label: string): string {
  const json = JSON.stringify({ v: WIRE_VERSION, ...action });
  return `${label.trim() || action.action}\n\n\`\`\`${ACTION_LANG}\n${json}\n\`\`\``;
}

export function parseAction(content: string): (CardAction & { label: string }) | null {
  const block = findBlock(content, ACTION_LANG);
  if (!block) return null;
  try {
    const value: unknown = JSON.parse(block.body);
    if (!isRecord(value) || value.v !== WIRE_VERSION) return null;
    if (typeof value.message !== "string" || typeof value.action !== "string") return null;
    if (value.value !== undefined && typeof value.value !== "string") return null;
    const action: CardAction = { v: 1, message: value.message, action: value.action };
    if (value.value !== undefined) action.value = value.value;
    if (value.values !== undefined) {
      if (!isRecord(value.values)) return null;
      const values: Record<string, string> = {};
      for (const [key, text] of Object.entries(value.values)) if (typeof text === "string") values[key] = str(text);
      action.values = values;
    }
    return { ...action, label: block.before };
  } catch {
    return null;
  }
}

/** Only credential-free http(s) URLs are ever shown as links. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// --- validation -----------------------------------------------------------

type Budget = { elements: number };

function readCard(value: unknown): Card {
  if (!isRecord(value) || value.type !== "card") throw new Error('The card root must have type "card".');
  const budget: Budget = { elements: 0 };
  const card: Card = { type: "card", children: readChildren(value.children, budget, 1) };
  const title = optString(value.title);
  const subtitle = optString(value.subtitle);
  const imageUrl = safeUrl(value.imageUrl);
  if (title) card.title = title;
  if (subtitle) card.subtitle = subtitle;
  if (imageUrl) card.imageUrl = imageUrl;
  return card;
}

function readChildren(value: unknown, budget: Budget, depth: number): CardChild[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Card children must be an array.");
  if (depth > MAX_DEPTH) throw new Error(`The card is nested more than ${MAX_DEPTH} levels deep.`);
  const out: CardChild[] = [];
  for (const item of value) {
    spend(budget);
    const child = readChild(item, budget, depth);
    if (child) out.push(child);
  }
  return out;
}

// Unknown element types are skipped so newer adapters still render on older plugins.
function readChild(value: unknown, budget: Budget, depth: number): CardChild | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "text": {
      const style = value.style === "plain" || value.style === "bold" || value.style === "muted" ? value.style : undefined;
      return { type: "text", content: str(value.content), ...(style ? { style } : {}) };
    }
    case "image": {
      const url = safeUrl(value.url);
      return url ? { type: "image", url, ...(optString(value.alt) ? { alt: optString(value.alt)! } : {}) } : null;
    }
    case "divider":
      return { type: "divider" };
    case "link": {
      const url = safeUrl(value.url);
      return url ? { type: "link", label: str(value.label) || url, url } : null;
    }
    case "section":
      return { type: "section", children: readChildren(value.children, budget, depth + 1) };
    case "fields": {
      const children: Field[] = [];
      for (const field of arr(value.children)) {
        spend(budget);
        if (isRecord(field)) children.push({ type: "field", label: str(field.label), value: str(field.value) });
      }
      return { type: "fields", children };
    }
    case "actions": {
      const children: ActionChild[] = [];
      for (const action of arr(value.children)) {
        spend(budget);
        const child = readAction(action);
        if (child) children.push(child);
      }
      return { type: "actions", children };
    }
    case "table": {
      const headers = arr(value.headers).map(str);
      const rows = arr(value.rows).map((row) => {
        spend(budget);
        return arr(row).map(str);
      });
      const align = arr(value.align).map((a) => (a === "center" || a === "right" ? a : "left"));
      const caption = optString(value.caption);
      return { type: "table", headers, rows, ...(align.length ? { align } : {}), ...(caption ? { caption } : {}) };
    }
    case "chart": {
      const chart = readChart(value.chart, budget);
      return chart ? { type: "chart", title: str(value.title), chart } : null;
    }
    case "text_input": {
      if (typeof value.id !== "string") return null;
      const input: CardChild = { type: "text_input", id: value.id, label: str(value.label) };
      const placeholder = optString(value.placeholder);
      const initialValue = optString(value.initialValue);
      if (placeholder) input.placeholder = placeholder;
      if (initialValue) input.initialValue = initialValue;
      if (value.multiline === true) input.multiline = true;
      return input;
    }
    default:
      return null;
  }
}

function readAction(value: unknown): ActionChild | null {
  if (!isRecord(value)) return null;
  const style = value.style === "primary" || value.style === "danger" ? value.style : undefined;
  if (value.type === "button" && typeof value.id === "string") {
    const button: Button = { type: "button", id: value.id, label: str(value.label) || value.id };
    if (style) button.style = style;
    if (typeof value.value === "string") button.value = value.value;
    if (value.disabled === true) button.disabled = true;
    return button;
  }
  if (value.type === "link-button") {
    const url = safeUrl(value.url);
    return url ? { type: "link-button", label: str(value.label) || url, url, ...(style ? { style } : {}) } : null;
  }
  if ((value.type === "select" || value.type === "radio_select") && typeof value.id === "string") {
    const options = arr(value.options)
      .filter(isRecord)
      .map((o) => ({ label: str(o.label), value: str(o.value), ...(optString(o.description) ? { description: optString(o.description)! } : {}) }));
    const select: Select = { type: value.type, id: value.id, label: str(value.label), options };
    const initialOption = optString(value.initialOption);
    const placeholder = optString(value.placeholder);
    if (initialOption) select.initialOption = initialOption;
    if (placeholder) select.placeholder = placeholder;
    return select;
  }
  return null;
}

function readChart(value: unknown, budget: Budget): Chart | null {
  if (!isRecord(value)) return null;
  if (value.type === "pie") {
    const segments = arr(value.segments)
      .filter(isRecord)
      .map((s) => {
        spend(budget);
        return { label: str(s.label), value: num(s.value) };
      })
      .filter((s) => s.value > 0);
    return segments.length ? { type: "pie", segments } : null;
  }
  if (value.type === "bar" || value.type === "line" || value.type === "area") {
    const categories = arr(value.categories).map(str);
    const series = arr(value.series)
      .filter(isRecord)
      .map((s) => ({
        name: str(s.name),
        data: arr(s.data)
          .filter(isRecord)
          .map((d) => {
            spend(budget);
            return { label: str(d.label), value: num(d.value) };
          }),
      }));
    if (!categories.length || !series.length) return null;
    const chart: Chart = { type: value.type, categories, series };
    const xLabel = optString(value.xLabel);
    const yLabel = optString(value.yLabel);
    if (xLabel) chart.xLabel = xLabel;
    if (yLabel) chart.yLabel = yLabel;
    return chart;
  }
  return null;
}

function spend(budget: Budget) {
  if (++budget.elements > MAX_ELEMENTS) throw new Error(`The card has more than ${MAX_ELEMENTS} elements.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + "…" : text;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value ? str(value) : undefined;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}
