// The plugin must accept exactly what a Chat SDK adapter receives from
// json-render: run a spec that uses every standard component through the real
// `toCard`, post it in the wire format, and read it back unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toCard } from "@json-render/chat";
import { formatCardMessage, parseCardMessage, type Card } from "../src/wire.ts";

const spec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Weekly report", subtitle: "Week 47" }, children: ["intro", "kpis", "div", "sec", "acts"] },
    intro: { type: "Text", props: { content: "Revenue is **up**.", style: "plain" }, children: [] },
    kpis: { type: "Fields", props: {}, children: ["f1", "f2"] },
    f1: { type: "Field", props: { label: "Revenue", value: "R$ 120k" }, children: [] },
    f2: { type: "Field", props: { label: "Orders", value: "312" }, children: [] },
    div: { type: "Divider", props: {}, children: [] },
    sec: { type: "Section", props: {}, children: ["table", "bars", "pie", "img"] },
    table: { type: "Table", props: { headers: ["Region", "Sales"], rows: [["South", "80"], ["North", "40"]], align: ["left", "right"] }, children: [] },
    bars: {
      type: "Chart",
      props: { title: "Sales by day", chart: { type: "bar", categories: ["Mon", "Tue"], series: [{ name: "Sales", values: [10, 12] }] } },
      children: [],
    },
    pie: {
      type: "Chart",
      props: { title: "Share", chart: { type: "pie", segments: [{ label: "A", value: 3 }, { label: "B", value: 1 }] } },
      children: [],
    },
    img: { type: "Image", props: { url: "https://example.com/chart.png", alt: "Chart" }, children: [] },
    acts: { type: "Actions", props: {}, children: ["ok", "no", "docs"] },
    ok: { type: "Button", props: { id: "approve", label: "Approve", style: "primary", value: "w47" }, children: [] },
    no: { type: "Button", props: { id: "reject", label: "Reject", style: "danger" }, children: [] },
    docs: { type: "LinkButton", props: { label: "Open dashboard", url: "https://example.com/dash" }, children: [] },
  },
};

test("every standard json-render component survives the Buzz wire format", () => {
  const card = toCard(spec as never) as unknown as Card;
  const parsed = parseCardMessage(formatCardMessage(card, "Weekly report"));
  assert.equal(parsed?.status, "ok", parsed?.status === "invalid" ? parsed.reason : "");
  // Chat SDK elements carry no fields this plugin drops, so the card reads back whole.
  assert.deepEqual(parsed.status === "ok" && parsed.card, JSON.parse(JSON.stringify(card)));
});
