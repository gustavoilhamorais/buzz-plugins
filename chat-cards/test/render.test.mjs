// Smoke test of the built plugin.js: run apply() against a fake host with real
// React and render a card message and a choice message to HTML.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { apply, inject } from "../plugin.js";
import { formatAction, formatCardMessage } from "../src/wire.ts";

function host() {
  const renderers = [];
  const replies = [];
  const snapshot = { status: "ready", generation: 1, session: { messages: { reply: (...args) => replies.push(args) } } };
  const ctx = {
    react: React,
    conversation: { ui: {}, registerMessage: (r) => renderers.push(r) },
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
  };
  apply(ctx);
  return { renderers, replies };
}

const message = (content) => ({ id: "m1", channelId: "c1", authorId: "bot", createdAt: 0, content, attachments: [] });

test("declares the host services it uses", () => {
  assert.deepEqual(inject, ["react", "conversation", "relay"]);
});

test("renders a card and claims only card messages", () => {
  const { renderers } = host();
  const card = {
    type: "card",
    title: "Weekly report",
    children: [
      { type: "fields", children: [{ type: "field", label: "Revenue", value: "R$ 120k" }] },
      { type: "table", headers: ["Region", "Sales"], rows: [["South", "80"]] },
      { type: "chart", title: "Sales", chart: { type: "bar", categories: ["Mon", "Tue"], series: [{ name: "Sales", data: [{ label: "Mon", value: 1 }, { label: "Tue", value: 2 }] }] } },
      { type: "chart", title: "Share", chart: { type: "pie", segments: [{ label: "A", value: 1 }, { label: "B", value: 3 }] } },
      { type: "actions", children: [{ type: "button", id: "ok", label: "Approve", style: "primary" }, { type: "select", id: "s", label: "Pick", options: [{ label: "One", value: "1" }] }] },
      { type: "text_input", id: "note", label: "Note" },
    ],
  };
  const msg = message(formatCardMessage(card, "Weekly report fallback"));
  const [cardRenderer, actionRenderer] = renderers;
  assert.equal(cardRenderer.matches(msg), true);
  assert.equal(actionRenderer.matches(msg), false);
  const html = renderToStaticMarkup(React.createElement(cardRenderer.component, { message: msg, canOpen: () => false, open: () => false }));
  for (const part of ["Weekly report", "R$ 120k", "<table", "<svg", "<path", "Approve", "<select", "Note"]) assert.ok(html.includes(part), part);
  assert.ok(!html.includes("fallback"), "the fallback text is hidden behind the card");
});

test("an invalid card says why and keeps the text", () => {
  const { renderers } = host();
  const msg = message("Hello\n\n```buzz-card\n{oops\n```");
  const html = renderToStaticMarkup(React.createElement(renderers[0].component, { message: msg }));
  assert.ok(html.includes("Hello") && html.includes("can’t be shown"));
});

test("renders a choice message", () => {
  const { renderers } = host();
  const msg = message(formatAction({ message: "m1", action: "ok" }, "Approve"));
  assert.equal(renderers[1].matches(msg), true);
  assert.equal(renderers[0].matches(msg), false);
  const html = renderToStaticMarkup(React.createElement(renderers[1].component, { message: msg }));
  assert.ok(html.includes("Approve"));
});
