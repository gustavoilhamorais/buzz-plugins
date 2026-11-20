import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findBlock,
  formatAction,
  formatCardMessage,
  hasCard,
  parseAction,
  parseCardMessage,
  safeUrl,
  type Card,
} from "../src/wire.ts";

const card: Card = {
  type: "card",
  title: "Deploy",
  children: [
    { type: "text", content: "Ready to ship **v2**" },
    { type: "fields", children: [{ type: "field", label: "Env", value: "prod" }] },
    { type: "actions", children: [{ type: "button", id: "approve", label: "Approve", style: "primary", value: "v2" }] },
  ],
};

test("a formatted card message round-trips and keeps its fallback", () => {
  const content = formatCardMessage(card, "Deploy: Ready to ship v2");
  assert.ok(content.startsWith("Deploy: Ready to ship v2\n\n```buzz-card\n"));
  assert.ok(hasCard(content));
  const parsed = parseCardMessage(content);
  assert.equal(parsed?.status, "ok");
  assert.deepEqual(parsed.status === "ok" && parsed.card, card);
  assert.equal(parsed.before, "Deploy: Ready to ship v2");
});

test("messages without a card block are not claimed", () => {
  assert.equal(hasCard("plain text"), false);
  assert.equal(hasCard("```json\n{}\n```"), false);
  assert.equal(hasCard("```buzz-card-action\n{}\n```"), false);
  assert.equal(parseCardMessage("talking about buzz-card in prose"), null);
});

test("invalid cards report a reason instead of throwing", () => {
  const bad = parseCardMessage("hi\n\n```buzz-card\n{not json\n```");
  assert.equal(bad?.status, "invalid");
  assert.equal(bad?.before, "hi");
  assert.equal(parseCardMessage('```buzz-card\n{"v":2,"card":{}}\n```')?.status, "invalid");
  assert.equal(parseCardMessage('```buzz-card\n{"v":1,"card":{"type":"text"}}\n```')?.status, "invalid");
});

test("unsafe URLs and unknown elements are dropped", () => {
  const content = formatCardMessage(
    {
      type: "card",
      imageUrl: "javascript:alert(1)",
      children: [
        { type: "link", label: "x", url: "javascript:alert(1)" },
        { type: "image", url: "https://user:pw@example.com/a.png" },
        { type: "future-widget" } as never,
        { type: "link", label: "ok", url: "https://example.com/" },
      ],
    },
    "",
  );
  const parsed = parseCardMessage(content);
  assert.equal(parsed?.status, "ok");
  assert.deepEqual(parsed.status === "ok" && parsed.card, {
    type: "card",
    children: [{ type: "link", label: "ok", url: "https://example.com/" }],
  });
  assert.equal(safeUrl("http://example.com"), "http://example.com/");
  assert.equal(safeUrl("data:text/html,x"), null);
});

test("oversized and deeply nested cards are refused", () => {
  const many = { type: "card", children: Array.from({ length: 1001 }, () => ({ type: "divider" })) };
  assert.equal(parseCardMessage("```buzz-card\n" + JSON.stringify({ v: 1, card: many }) + "\n```")?.status, "invalid");
  let nested: unknown = { type: "text", content: "deep" };
  for (let i = 0; i < 10; i++) nested = { type: "section", children: [nested] };
  const deep = { type: "card", children: [nested] };
  assert.equal(parseCardMessage("```buzz-card\n" + JSON.stringify({ v: 1, card: deep }) + "\n```")?.status, "invalid");
});

test("fences follow CommonMark: longer fences and tildes", () => {
  const body = JSON.stringify({ v: 1, card });
  assert.equal(parseCardMessage("````buzz-card\n" + body + "\n````\nafter")?.status, "ok");
  assert.equal(parseCardMessage("~~~buzz-card\n" + body + "\n~~~")?.status, "ok");
  assert.equal(findBlock("```buzz-card\n" + body + "\n```\ntail", "buzz-card")?.after, "tail");
});

test("actions round-trip and name the card message", () => {
  const content = formatAction({ message: "abc", action: "approve", value: "v2" }, "Approve");
  assert.deepEqual(parseAction(content), { v: 1, message: "abc", action: "approve", value: "v2", label: "Approve" });
  assert.equal(hasCard(content), false);
  assert.equal(parseAction("```buzz-card-action\n{\"v\":1,\"action\":\"x\"}\n```"), null);
});
