import type { Context, MessageRenderer } from "@buzz/author";
import type * as ReactTypes from "react";
import {
  formatAction,
  hasCard,
  parseAction,
  parseCardMessage,
  type ActionChild,
  type Button,
  type Card,
  type CardChild,
  type Chart,
  type Select,
} from "./wire";

export const inject = ["react", "conversation", "relay"];

type Message = Parameters<MessageRenderer["matches"]>[0];
type MarkdownProps = { content: string; openLink?: (url: string) => boolean; scale?: "message" | "document" };
type Send = (action: string, value: string | undefined, label: string) => Promise<void>;

const SERIES_COLORS = ["var(--chart-series-1)", "var(--chart-series-2)", "var(--chart-series-3)", "var(--chart-series-4)"];
const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]!;

export function apply(ctx: Context) {
  const React = ctx.react;
  const { useState, useSyncExternalStore } = React;
  // Newer hosts expose the shared Markdown renderer; older ones get plain text.
  const Markdown = (ctx.conversation.ui as { Markdown?: ReactTypes.ComponentType<MarkdownProps> }).Markdown;

  function useSession() {
    const snapshot = useSyncExternalStore(
      (listener) => ctx.relay.subscribe(listener),
      () => ctx.relay.snapshot(),
      () => ctx.relay.snapshot(),
    );
    return snapshot.status === "ready" ? snapshot.session : null;
  }

  function Prose({ content, style }: { content: string; style?: "plain" | "bold" | "muted" | undefined }) {
    const look: ReactTypes.CSSProperties = {
      fontWeight: style === "bold" ? 600 : undefined,
      color: style === "muted" ? "var(--text-subtle)" : undefined,
    };
    if (Markdown) return <div style={look}><Markdown content={content} /></div>;
    return <p style={{ ...look, margin: 0, whiteSpace: "pre-wrap" }}>{content}</p>;
  }

  // The host Markdown owns link safety and opening the external browser.
  function ExternalLink({ url, children }: { url: string; children: string }) {
    if (Markdown) return <Markdown content={`[${children.replace(/[\\[\]]/g, "\\$&")}](<${url}>)`} />;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-link)" }}>
        {children}
      </a>
    );
  }

  function CardView({ card, send }: { card: Card; send: Send | null }) {
    return (
      <div
        className="ui-card"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", padding: "var(--space-panel-inset)", maxWidth: "40rem" }}
      >
        {card.title || card.subtitle ? (
          <header>
            {card.title ? <h3 style={{ margin: 0 }}>{card.title}</h3> : null}
            {card.subtitle ? <p style={{ margin: 0, color: "var(--text-subtle)" }}>{card.subtitle}</p> : null}
          </header>
        ) : null}
        {card.imageUrl ? <ExternalLink url={card.imageUrl}>Open image</ExternalLink> : null}
        <Children items={card.children} send={send} />
      </div>
    );
  }

  function Children({ items, send }: { items: CardChild[]; send: Send | null }) {
    return <>{items.map((child, i) => <Child key={i} child={child} send={send} />)}</>;
  }

  function Child({ child, send }: { child: CardChild; send: Send | null }) {
    switch (child.type) {
      case "text":
        return <Prose content={child.content} style={child.style} />;
      case "divider":
        return <hr style={{ border: 0, borderTop: "1px solid var(--border-standard)", margin: 0, width: "100%" }} />;
      case "image":
        // Remote images stay links: loading them would reveal the reader to any host.
        return <ExternalLink url={child.url}>{child.alt ? `Image: ${child.alt}` : "Open image"}</ExternalLink>;
      case "link":
        return <ExternalLink url={child.url}>{child.label}</ExternalLink>;
      case "section":
        return (
          <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <Children items={child.children} send={send} />
          </section>
        );
      case "fields":
        return (
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "var(--space-2)", margin: 0 }}>
            {child.children.map((field, i) => (
              <div key={i}>
                <dt style={{ color: "var(--text-subtle)", fontSize: "var(--text-caption)" }}>{field.label}</dt>
                <dd style={{ margin: 0 }}>{field.value}</dd>
              </div>
            ))}
          </dl>
        );
      case "table":
        return <TableView table={child} />;
      case "chart":
        return <ChartView title={child.title} chart={child.chart} />;
      case "actions":
        return (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            {child.children.map((action, i) => <Action key={i} action={action} send={send} />)}
          </div>
        );
      case "text_input":
        return <TextInputView input={child} send={send} />;
    }
  }

  function TableView({ table }: { table: Extract<CardChild, { type: "table" }> }) {
    const align = (i: number) => table.align?.[i] ?? "left";
    const cell: ReactTypes.CSSProperties = { padding: "var(--space-1) var(--space-2)", borderBottom: "1px solid var(--border-standard)" };
    return (
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          {table.caption ? <caption style={{ textAlign: "left", color: "var(--text-subtle)" }}>{table.caption}</caption> : null}
          {table.headers.length ? (
            <thead>
              <tr>{table.headers.map((h, i) => <th key={i} style={{ ...cell, textAlign: align(i) }}>{h}</th>)}</tr>
            </thead>
          ) : null}
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r}>{row.map((value, i) => <td key={i} style={{ ...cell, textAlign: align(i) }}>{value}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function ChartView({ title, chart }: { title: string; chart: Chart }) {
    const legend = chart.type === "pie" ? chart.segments.map((s) => `${s.label}: ${s.value}`) : chart.series.map((s) => s.name);
    return (
      <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        {title ? <figcaption style={{ fontWeight: 600 }}>{title}</figcaption> : null}
        {chart.type === "pie" ? <Pie chart={chart} label={title} /> : <Series chart={chart} label={title} />}
        <ul style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", listStyle: "none", margin: 0, padding: 0, fontSize: "var(--text-caption)" }}>
          {legend.map((name, i) => (
            <li key={i} style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <span aria-hidden style={{ width: "0.75em", height: "0.75em", borderRadius: 2, background: color(i) }} />
              {name}
            </li>
          ))}
        </ul>
      </figure>
    );
  }

  function Pie({ chart, label }: { chart: Extract<Chart, { type: "pie" }>; label: string }) {
    const total = chart.segments.reduce((sum, s) => sum + s.value, 0);
    let angle = -Math.PI / 2;
    const point = (a: number) => `${50 + 45 * Math.cos(a)} ${50 + 45 * Math.sin(a)}`;
    return (
      <svg viewBox="0 0 100 100" role="img" aria-label={label || "Pie chart"} style={{ width: "10rem", maxWidth: "100%" }}>
        {chart.segments.map((s, i) => {
          const sweep = (s.value / total) * Math.PI * 2;
          const start = angle;
          angle += sweep;
          if (sweep >= Math.PI * 2 - 1e-9) return <circle key={i} cx="50" cy="50" r="45" style={{ fill: color(i) }} />;
          const large = sweep > Math.PI ? 1 : 0;
          return <path key={i} d={`M50 50 L${point(start)} A45 45 0 ${large} 1 ${point(angle)} Z`} style={{ fill: color(i) }} />;
        })}
      </svg>
    );
  }

  function Series({ chart, label }: { chart: Exclude<Chart, { type: "pie" }>; label: string }) {
    const W = 320, H = 160, left = 4, right = 4, top = 8, bottom = 22;
    const values = chart.series.flatMap((s) => s.data.map((d) => d.value));
    const max = Math.max(0, ...values), min = Math.min(0, ...values);
    const span = max - min || 1;
    const y = (v: number) => top + ((max - v) / span) * (H - top - bottom);
    const n = chart.categories.length;
    const band = (W - left - right) / n;
    const valueAt = (s: (typeof chart.series)[number], category: string, i: number) =>
      (s.data.find((d) => d.label === category) ?? s.data[i])?.value ?? 0;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label || `${chart.type} chart`} style={{ width: "100%", maxWidth: "32rem" }}>
        <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} style={{ stroke: "var(--border-standard)" }} />
        {chart.type === "bar"
          ? chart.categories.map((category, c) =>
              chart.series.map((s, i) => {
                const width = (band * 0.8) / chart.series.length;
                const v = valueAt(s, category, c);
                return (
                  <rect key={`${c}-${i}`} x={left + c * band + band * 0.1 + i * width} width={Math.max(width - 1, 1)}
                    y={Math.min(y(v), y(0))} height={Math.abs(y(v) - y(0))} style={{ fill: color(i) }}>
                    <title>{`${s.name} · ${category}: ${v}`}</title>
                  </rect>
                );
              }),
            )
          : chart.series.map((s, i) => {
              const pts = chart.categories.map((category, c) => `${left + c * band + band / 2},${y(valueAt(s, category, c))}`);
              return chart.type === "area" ? (
                <polygon key={i} points={`${left + band / 2},${y(0)} ${pts.join(" ")} ${left + (n - 0.5) * band},${y(0)}`}
                  style={{ fill: color(i), fillOpacity: 0.35, stroke: color(i), strokeWidth: 2 }} />
              ) : (
                <polyline key={i} points={pts.join(" ")} style={{ fill: "none", stroke: color(i), strokeWidth: 2 }} />
              );
            })}
        {chart.categories.map((category, c) => (
          <text key={c} x={left + c * band + band / 2} y={H - 6} textAnchor="middle" style={{ fill: "var(--text-subtle)", fontSize: 10 }}>
            {category.length > 12 ? category.slice(0, 11) + "…" : category}
          </text>
        ))}
      </svg>
    );
  }

  function useSender(send: Send | null) {
    const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
    const run = (action: string, value: string | undefined, label: string) => {
      if (!send || state === "sending") return;
      setState("sending");
      send(action, value, label).then(() => setState("sent"), () => setState("failed"));
    };
    return { state, run, disabled: !send || state === "sending" };
  }

  function Status({ state }: { state: string }) {
    if (state === "sent") return <span style={{ color: "var(--text-subtle)", fontSize: "var(--text-caption)" }}>Sent</span>;
    if (state === "failed") return <span style={{ color: "var(--text-danger)", fontSize: "var(--text-caption)" }}>Couldn’t send</span>;
    return null;
  }

  function Action({ action, send }: { action: ActionChild; send: Send | null }) {
    if (action.type === "link-button") return <ExternalLink url={action.url}>{action.label}</ExternalLink>;
    if (action.type === "button") return <ButtonView button={action} send={send} />;
    return <SelectView select={action} send={send} />;
  }

  function ButtonView({ button, send }: { button: Button; send: Send | null }) {
    const sender = useSender(send);
    const style: ReactTypes.CSSProperties =
      button.style === "primary" ? { background: "var(--accent)", color: "var(--text-on-accent)" }
      : button.style === "danger" ? { color: "var(--text-danger)" }
      : {};
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
        <button type="button" style={style} disabled={button.disabled || sender.disabled}
          onClick={() => sender.run(button.id, button.value, button.label)}>
          {button.label}
        </button>
        <Status state={sender.state} />
      </span>
    );
  }

  function SelectView({ select, send }: { select: Select; send: Send | null }) {
    const sender = useSender(send);
    const choose = (value: string) => {
      const option = select.options.find((o) => o.value === value);
      if (option) sender.run(select.id, option.value, `${select.label}: ${option.label}`);
    };
    if (select.type === "radio_select")
      return (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={sender.disabled}>
          <legend>{select.label}</legend>
          {select.options.map((o) => (
            <label key={o.value} style={{ display: "block" }}>
              <input type="radio" name={select.id} defaultChecked={o.value === select.initialOption} onChange={() => choose(o.value)} /> {o.label}
            </label>
          ))}
          <Status state={sender.state} />
        </fieldset>
      );
    return (
      <label style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
        {select.label}
        <select defaultValue={select.initialOption ?? ""} disabled={sender.disabled} onChange={(e) => choose(e.currentTarget.value)}>
          <option value="" disabled>{select.placeholder ?? "Choose…"}</option>
          {select.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Status state={sender.state} />
      </label>
    );
  }

  function TextInputView({ input, send }: { input: Extract<CardChild, { type: "text_input" }>; send: Send | null }) {
    const sender = useSender(send);
    const [text, setText] = useState(input.initialValue ?? "");
    const field = { value: text, placeholder: input.placeholder, onChange: (e: { currentTarget: { value: string } }) => setText(e.currentTarget.value), style: { width: "100%" } };
    return (
      <form style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) sender.run(input.id, text, `${input.label}: ${text}`); }}>
        <label>
          {input.label}
          {input.multiline ? <textarea rows={3} {...field} /> : <input type="text" {...field} />}
        </label>
        <span style={{ display: "flex", gap: "var(--space-1)", alignItems: "center" }}>
          <button type="submit" disabled={sender.disabled || !text.trim()}>Send</button>
          <Status state={sender.state} />
        </span>
      </form>
    );
  }

  function CardMessage({ message }: { message: Message }) {
    const session = useSession();
    const parsed = parseCardMessage(message.content);
    if (!parsed || parsed.status === "invalid") {
      // Keep the author's readable text and say why the card is missing.
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          {parsed?.before ? <Prose content={parsed.before} /> : null}
          <p style={{ margin: 0, color: "var(--text-subtle)", fontSize: "var(--text-caption)" }}>
            This card can’t be shown. {parsed?.status === "invalid" ? parsed.reason : ""}
          </p>
        </div>
      );
    }
    // The text before the card is its fallback for readers without this plugin.
    const send: Send | null = session
      ? async (action, value, label) => {
          const content = formatAction({ message: message.id, action, ...(value === undefined ? {} : { value }) }, label);
          session.messages.reply(message.channelId, message.threadRootId ?? message.id, content, [message.authorId]);
        }
      : null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <CardView card={parsed.card} send={send} />
        {parsed.after ? <Prose content={parsed.after} /> : null}
      </div>
    );
  }

  function ActionMessage({ message }: { message: Message }) {
    const action = parseAction(message.content);
    return (
      <p style={{ margin: 0, color: "var(--text-subtle)" }}>
        Chose <strong style={{ color: "var(--text-standard)" }}>{action?.label || action?.action}</strong>
      </p>
    );
  }

  ctx.conversation.registerMessage({
    id: "card",
    title: "Chat card",
    matches: (message) => hasCard(message.content),
    component: CardMessage,
  });
  ctx.conversation.registerMessage({
    id: "card-action",
    title: "Chat card choice",
    matches: (message) => parseAction(message.content) !== null,
    component: ActionMessage,
  });
}
