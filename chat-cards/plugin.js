// src/wire.ts
var CARD_LANG = "buzz-card";
var ACTION_LANG = "buzz-card-action";
var MAX_CONTENT = 262144;
var MAX_ELEMENTS = 1e3;
var MAX_DEPTH = 8;
var MAX_STRING = 8e3;
/** Finds the first fenced block whose info string is exactly `lang`. */
function findBlock(content, lang) {
	if (content.length > MAX_CONTENT) return null;
	const start = new RegExp("(^|\\n)(`{3,}|~{3,})[ \\t]*" + lang + "[ \\t]*\\r?\\n").exec(content);
	if (!start) return null;
	const fence = start[2];
	const bodyStart = start.index + start[0].length;
	const close = new RegExp("\\n" + fence[0] + "{" + fence.length + ",}[ \\t]*(\\r?\\n|$)", "g");
	close.lastIndex = bodyStart - 1;
	const end = close.exec(content);
	const bodyEnd = end ? end.index : content.length;
	return {
		before: content.slice(0, start.index).trim(),
		body: content.slice(bodyStart, bodyEnd),
		after: end ? content.slice(end.index + end[0].length).trim() : ""
	};
}
function hasCard(content) {
	return content.includes("buzz-card") && findBlock(content, "buzz-card") !== null;
}
function parseCardMessage(content) {
	const block = findBlock(content, CARD_LANG);
	if (!block) return null;
	const { before, after } = block;
	let envelope;
	try {
		envelope = JSON.parse(block.body);
	} catch {
		return {
			status: "invalid",
			reason: "The card is not valid JSON.",
			before,
			after
		};
	}
	if (!isRecord(envelope) || envelope.v !== 1) return {
		status: "invalid",
		reason: `Unsupported card version; this plugin reads version 1.`,
		before,
		after
	};
	try {
		return {
			status: "ok",
			card: readCard(envelope.card),
			before,
			after
		};
	} catch (error) {
		return {
			status: "invalid",
			reason: error instanceof Error ? error.message : String(error),
			before,
			after
		};
	}
}
function formatAction(action, label) {
	const json = JSON.stringify({
		v: 1,
		...action
	});
	return `${label.trim() || action.action}\n\n\`\`\`${ACTION_LANG}\n${json}\n\`\`\``;
}
function parseAction(content) {
	const block = findBlock(content, ACTION_LANG);
	if (!block) return null;
	try {
		const value = JSON.parse(block.body);
		if (!isRecord(value) || value.v !== 1) return null;
		if (typeof value.message !== "string" || typeof value.action !== "string") return null;
		if (value.value !== void 0 && typeof value.value !== "string") return null;
		const action = {
			v: 1,
			message: value.message,
			action: value.action
		};
		if (value.value !== void 0) action.value = value.value;
		if (value.values !== void 0) {
			if (!isRecord(value.values)) return null;
			const values = {};
			for (const [key, text] of Object.entries(value.values)) if (typeof text === "string") values[key] = str(text);
			action.values = values;
		}
		return {
			...action,
			label: block.before
		};
	} catch {
		return null;
	}
}
/** Only credential-free http(s) URLs are ever shown as links. */
function safeUrl(value) {
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
function readCard(value) {
	if (!isRecord(value) || value.type !== "card") throw new Error("The card root must have type \"card\".");
	const card = {
		type: "card",
		children: readChildren(value.children, { elements: 0 }, 1)
	};
	const title = optString(value.title);
	const subtitle = optString(value.subtitle);
	const imageUrl = safeUrl(value.imageUrl);
	if (title) card.title = title;
	if (subtitle) card.subtitle = subtitle;
	if (imageUrl) card.imageUrl = imageUrl;
	return card;
}
function readChildren(value, budget, depth) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("Card children must be an array.");
	if (depth > MAX_DEPTH) throw new Error(`The card is nested more than ${MAX_DEPTH} levels deep.`);
	const out = [];
	for (const item of value) {
		spend(budget);
		const child = readChild(item, budget, depth);
		if (child) out.push(child);
	}
	return out;
}
function readChild(value, budget, depth) {
	if (!isRecord(value)) return null;
	switch (value.type) {
		case "text": {
			const style = value.style === "plain" || value.style === "bold" || value.style === "muted" ? value.style : void 0;
			return {
				type: "text",
				content: str(value.content),
				...style ? { style } : {}
			};
		}
		case "image": {
			const url = safeUrl(value.url);
			return url ? {
				type: "image",
				url,
				...optString(value.alt) ? { alt: optString(value.alt) } : {}
			} : null;
		}
		case "divider": return { type: "divider" };
		case "link": {
			const url = safeUrl(value.url);
			return url ? {
				type: "link",
				label: str(value.label) || url,
				url
			} : null;
		}
		case "section": return {
			type: "section",
			children: readChildren(value.children, budget, depth + 1)
		};
		case "fields": {
			const children = [];
			for (const field of arr(value.children)) {
				spend(budget);
				if (isRecord(field)) children.push({
					type: "field",
					label: str(field.label),
					value: str(field.value)
				});
			}
			return {
				type: "fields",
				children
			};
		}
		case "actions": {
			const children = [];
			for (const action of arr(value.children)) {
				spend(budget);
				const child = readAction(action);
				if (child) children.push(child);
			}
			return {
				type: "actions",
				children
			};
		}
		case "table": {
			const headers = arr(value.headers).map(str);
			const rows = arr(value.rows).map((row) => {
				spend(budget);
				return arr(row).map(str);
			});
			const align = arr(value.align).map((a) => a === "center" || a === "right" ? a : "left");
			const caption = optString(value.caption);
			return {
				type: "table",
				headers,
				rows,
				...align.length ? { align } : {},
				...caption ? { caption } : {}
			};
		}
		case "chart": {
			const chart = readChart(value.chart, budget);
			return chart ? {
				type: "chart",
				title: str(value.title),
				chart
			} : null;
		}
		case "text_input": {
			if (typeof value.id !== "string") return null;
			const input = {
				type: "text_input",
				id: value.id,
				label: str(value.label)
			};
			const placeholder = optString(value.placeholder);
			const initialValue = optString(value.initialValue);
			if (placeholder) input.placeholder = placeholder;
			if (initialValue) input.initialValue = initialValue;
			if (value.multiline === true) input.multiline = true;
			return input;
		}
		default: return null;
	}
}
function readAction(value) {
	if (!isRecord(value)) return null;
	const style = value.style === "primary" || value.style === "danger" ? value.style : void 0;
	if (value.type === "button" && typeof value.id === "string") {
		const button = {
			type: "button",
			id: value.id,
			label: str(value.label) || value.id
		};
		if (style) button.style = style;
		if (typeof value.value === "string") button.value = value.value;
		if (value.disabled === true) button.disabled = true;
		return button;
	}
	if (value.type === "link-button") {
		const url = safeUrl(value.url);
		return url ? {
			type: "link-button",
			label: str(value.label) || url,
			url,
			...style ? { style } : {}
		} : null;
	}
	if ((value.type === "select" || value.type === "radio_select") && typeof value.id === "string") {
		const options = arr(value.options).filter(isRecord).map((o) => ({
			label: str(o.label),
			value: str(o.value),
			...optString(o.description) ? { description: optString(o.description) } : {}
		}));
		const select = {
			type: value.type,
			id: value.id,
			label: str(value.label),
			options
		};
		const initialOption = optString(value.initialOption);
		const placeholder = optString(value.placeholder);
		if (initialOption) select.initialOption = initialOption;
		if (placeholder) select.placeholder = placeholder;
		return select;
	}
	return null;
}
function readChart(value, budget) {
	if (!isRecord(value)) return null;
	if (value.type === "pie") {
		const segments = arr(value.segments).filter(isRecord).map((s) => {
			spend(budget);
			return {
				label: str(s.label),
				value: num(s.value)
			};
		}).filter((s) => s.value > 0);
		return segments.length ? {
			type: "pie",
			segments
		} : null;
	}
	if (value.type === "bar" || value.type === "line" || value.type === "area") {
		const categories = arr(value.categories).map(str);
		const series = arr(value.series).filter(isRecord).map((s) => ({
			name: str(s.name),
			data: arr(s.data).filter(isRecord).map((d) => {
				spend(budget);
				return {
					label: str(d.label),
					value: num(d.value)
				};
			})
		}));
		if (!categories.length || !series.length) return null;
		const chart = {
			type: value.type,
			categories,
			series
		};
		const xLabel = optString(value.xLabel);
		const yLabel = optString(value.yLabel);
		if (xLabel) chart.xLabel = xLabel;
		if (yLabel) chart.yLabel = yLabel;
		return chart;
	}
	return null;
}
function spend(budget) {
	if (++budget.elements > MAX_ELEMENTS) throw new Error(`The card has more than ${MAX_ELEMENTS} elements.`);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function arr(value) {
	return Array.isArray(value) ? value : [];
}
function str(value) {
	const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
	return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + "…" : text;
}
function optString(value) {
	return typeof value === "string" && value ? str(value) : void 0;
}
function num(value) {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : 0;
}
// src/index.tsx
var inject = [
	"react",
	"conversation",
	"relay"
];
var SERIES_COLORS = [
	"var(--chart-series-1)",
	"var(--chart-series-2)",
	"var(--chart-series-3)",
	"var(--chart-series-4)"
];
var color = (i) => SERIES_COLORS[i % SERIES_COLORS.length];
function inputIds(children) {
	return children.flatMap((child) => child.type === "text_input" ? [child] : child.type === "section" ? inputIds(child.children) : []);
}
function apply(ctx) {
	const React = ctx.react;
	const { useContext, useRef, useState, useSyncExternalStore } = React;
	const InputsContext = React.createContext({});
	const Markdown = ctx.conversation.ui.Markdown;
	function useSession() {
		const snapshot = useSyncExternalStore((listener) => ctx.relay.subscribe(listener), () => ctx.relay.snapshot(), () => ctx.relay.snapshot());
		return snapshot.status === "ready" ? snapshot.session : null;
	}
	function Prose({ content, style }) {
		const look = {
			fontWeight: style === "bold" ? 600 : void 0,
			color: style === "muted" ? "var(--text-subtle)" : void 0
		};
		if (Markdown) return /* @__PURE__ */ React.createElement("div", { style: look }, /* @__PURE__ */ React.createElement(Markdown, { content }));
		return /* @__PURE__ */ React.createElement("p", { style: {
			...look,
			margin: 0,
			whiteSpace: "pre-wrap"
		} }, content);
	}
	function ExternalLink({ url, children }) {
		if (Markdown) return /* @__PURE__ */ React.createElement(Markdown, { content: `[${children.replace(/[\\[\]]/g, "\\$&")}](<${url}>)` });
		return /* @__PURE__ */ React.createElement("a", {
			href: url,
			target: "_blank",
			rel: "noopener noreferrer",
			style: { color: "var(--text-link)" }
		}, children);
	}
	function CardView({ card, send }) {
		return /* @__PURE__ */ React.createElement("div", {
			className: "ui-card",
			style: {
				display: "flex",
				flexDirection: "column",
				gap: "var(--space-2)",
				padding: "var(--space-panel-inset)",
				maxWidth: "40rem"
			}
		}, card.title || card.subtitle ? /* @__PURE__ */ React.createElement("header", null, card.title ? /* @__PURE__ */ React.createElement("h3", { style: { margin: 0 } }, card.title) : null, card.subtitle ? /* @__PURE__ */ React.createElement("p", { style: {
			margin: 0,
			color: "var(--text-subtle)"
		} }, card.subtitle) : null) : null, card.imageUrl ? /* @__PURE__ */ React.createElement(ExternalLink, { url: card.imageUrl }, "Open image") : null, /* @__PURE__ */ React.createElement(Children, {
			items: card.children,
			send
		}));
	}
	function Children({ items, send }) {
		return /* @__PURE__ */ React.createElement(React.Fragment, null, items.map((child, i) => /* @__PURE__ */ React.createElement(Child, {
			key: i,
			child,
			send
		})));
	}
	function Child({ child, send }) {
		switch (child.type) {
			case "text": return /* @__PURE__ */ React.createElement(Prose, {
				content: child.content,
				style: child.style
			});
			case "divider": return /* @__PURE__ */ React.createElement("hr", { style: {
				border: 0,
				borderTop: "1px solid var(--border-standard)",
				margin: 0,
				width: "100%"
			} });
			case "image": return /* @__PURE__ */ React.createElement(ExternalLink, { url: child.url }, child.alt ? `Image: ${child.alt}` : "Open image");
			case "link": return /* @__PURE__ */ React.createElement(ExternalLink, { url: child.url }, child.label);
			case "section": return /* @__PURE__ */ React.createElement("section", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "var(--space-2)"
			} }, /* @__PURE__ */ React.createElement(Children, {
				items: child.children,
				send
			}));
			case "fields": return /* @__PURE__ */ React.createElement("dl", { style: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
				gap: "var(--space-2)",
				margin: 0
			} }, child.children.map((field, i) => /* @__PURE__ */ React.createElement("div", { key: i }, /* @__PURE__ */ React.createElement("dt", { style: {
				color: "var(--text-subtle)",
				fontSize: "var(--text-caption)"
			} }, field.label), /* @__PURE__ */ React.createElement("dd", { style: { margin: 0 } }, field.value))));
			case "table": return /* @__PURE__ */ React.createElement(TableView, { table: child });
			case "chart": return /* @__PURE__ */ React.createElement(ChartView, {
				title: child.title,
				chart: child.chart
			});
			case "actions": return /* @__PURE__ */ React.createElement("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				gap: "var(--space-2)",
				alignItems: "center"
			} }, child.children.map((action, i) => /* @__PURE__ */ React.createElement(Action, {
				key: i,
				action,
				send
			})));
			case "text_input": return /* @__PURE__ */ React.createElement(TextInputView, { input: child });
		}
	}
	function TableView({ table }) {
		const align = (i) => table.align?.[i] ?? "left";
		const cell = {
			padding: "var(--space-1) var(--space-2)",
			borderBottom: "1px solid var(--border-standard)"
		};
		return /* @__PURE__ */ React.createElement("div", { style: {
			overflowX: "auto",
			maxWidth: "100%"
		} }, /* @__PURE__ */ React.createElement("table", { style: {
			borderCollapse: "collapse",
			width: "100%"
		} }, table.caption ? /* @__PURE__ */ React.createElement("caption", { style: {
			textAlign: "left",
			color: "var(--text-subtle)"
		} }, table.caption) : null, table.headers.length ? /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, table.headers.map((h, i) => /* @__PURE__ */ React.createElement("th", {
			key: i,
			style: {
				...cell,
				textAlign: align(i)
			}
		}, h)))) : null, /* @__PURE__ */ React.createElement("tbody", null, table.rows.map((row, r) => /* @__PURE__ */ React.createElement("tr", { key: r }, row.map((value, i) => /* @__PURE__ */ React.createElement("td", {
			key: i,
			style: {
				...cell,
				textAlign: align(i)
			}
		}, value)))))));
	}
	function ChartView({ title, chart }) {
		const legend = chart.type === "pie" ? chart.segments.map((s) => `${s.label}: ${s.value}`) : chart.series.map((s) => s.name);
		return /* @__PURE__ */ React.createElement("figure", { style: {
			margin: 0,
			display: "flex",
			flexDirection: "column",
			gap: "var(--space-1)"
		} }, title ? /* @__PURE__ */ React.createElement("figcaption", { style: { fontWeight: 600 } }, title) : null, chart.type === "pie" ? /* @__PURE__ */ React.createElement(Pie, {
			chart,
			label: title
		}) : /* @__PURE__ */ React.createElement(Series, {
			chart,
			label: title
		}), /* @__PURE__ */ React.createElement("ul", { style: {
			display: "flex",
			flexWrap: "wrap",
			gap: "var(--space-2)",
			listStyle: "none",
			margin: 0,
			padding: 0,
			fontSize: "var(--text-caption)"
		} }, legend.map((name, i) => /* @__PURE__ */ React.createElement("li", {
			key: i,
			style: {
				display: "flex",
				alignItems: "center",
				gap: "var(--space-1)"
			}
		}, /* @__PURE__ */ React.createElement("span", {
			"aria-hidden": true,
			style: {
				width: "0.75em",
				height: "0.75em",
				borderRadius: 2,
				background: color(i)
			}
		}), name))));
	}
	function Pie({ chart, label }) {
		const total = chart.segments.reduce((sum, s) => sum + s.value, 0);
		let angle = -Math.PI / 2;
		const point = (a) => `${50 + 45 * Math.cos(a)} ${50 + 45 * Math.sin(a)}`;
		return /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 100 100",
			role: "img",
			"aria-label": label || "Pie chart",
			style: {
				width: "10rem",
				maxWidth: "100%"
			}
		}, chart.segments.map((s, i) => {
			const sweep = s.value / total * Math.PI * 2;
			const start = angle;
			angle += sweep;
			if (sweep >= Math.PI * 2 - 1e-9) return /* @__PURE__ */ React.createElement("circle", {
				key: i,
				cx: "50",
				cy: "50",
				r: "45",
				style: { fill: color(i) }
			});
			const large = sweep > Math.PI ? 1 : 0;
			return /* @__PURE__ */ React.createElement("path", {
				key: i,
				d: `M50 50 L${point(start)} A45 45 0 ${large} 1 ${point(angle)} Z`,
				style: { fill: color(i) }
			});
		}));
	}
	function Series({ chart, label }) {
		const W = 320, H = 160, left = 4, top = 8;
		const values = chart.series.flatMap((s) => s.data.map((d) => d.value));
		const max = Math.max(0, ...values);
		const span = max - Math.min(0, ...values) || 1;
		const y = (v) => top + (max - v) / span * 130;
		const n = chart.categories.length;
		const band = 312 / n;
		const valueAt = (s, category, i) => (s.data.find((d) => d.label === category) ?? s.data[i])?.value ?? 0;
		return /* @__PURE__ */ React.createElement("svg", {
			viewBox: `0 0 ${W} ${H}`,
			role: "img",
			"aria-label": label || `${chart.type} chart`,
			style: {
				width: "100%",
				maxWidth: "32rem"
			}
		}, /* @__PURE__ */ React.createElement("line", {
			x1: left,
			x2: 316,
			y1: y(0),
			y2: y(0),
			style: { stroke: "var(--border-standard)" }
		}), chart.type === "bar" ? chart.categories.map((category, c) => chart.series.map((s, i) => {
			const width = band * .8 / chart.series.length;
			const v = valueAt(s, category, c);
			return /* @__PURE__ */ React.createElement("rect", {
				key: `${c}-${i}`,
				x: left + c * band + band * .1 + i * width,
				width: Math.max(width - 1, 1),
				y: Math.min(y(v), y(0)),
				height: Math.abs(y(v) - y(0)),
				style: { fill: color(i) }
			}, /* @__PURE__ */ React.createElement("title", null, `${s.name} · ${category}: ${v}`));
		})) : chart.series.map((s, i) => {
			const pts = chart.categories.map((category, c) => `${left + c * band + band / 2},${y(valueAt(s, category, c))}`);
			return chart.type === "area" ? /* @__PURE__ */ React.createElement("polygon", {
				key: i,
				points: `${left + band / 2},${y(0)} ${pts.join(" ")} ${left + (n - .5) * band},${y(0)}`,
				style: {
					fill: color(i),
					fillOpacity: .35,
					stroke: color(i),
					strokeWidth: 2
				}
			}) : /* @__PURE__ */ React.createElement("polyline", {
				key: i,
				points: pts.join(" "),
				style: {
					fill: "none",
					stroke: color(i),
					strokeWidth: 2
				}
			});
		}), chart.categories.map((category, c) => /* @__PURE__ */ React.createElement("text", {
			key: c,
			x: left + c * band + band / 2,
			y: 154,
			textAnchor: "middle",
			style: {
				fill: "var(--text-subtle)",
				fontSize: 10
			}
		}, category.length > 12 ? category.slice(0, 11) + "…" : category)));
	}
	function useSender(send) {
		const [state, setState] = useState("idle");
		const run = (action, value, label) => {
			if (!send || state === "sending") return;
			setState("sending");
			send(action, value, label).then(() => setState("sent"), () => setState("failed"));
		};
		return {
			state,
			run,
			disabled: !send || state === "sending"
		};
	}
	function Status({ state }) {
		if (state === "sent") return /* @__PURE__ */ React.createElement("span", { style: {
			color: "var(--text-subtle)",
			fontSize: "var(--text-caption)"
		} }, "Sent");
		if (state === "failed") return /* @__PURE__ */ React.createElement("span", { style: {
			color: "var(--text-danger)",
			fontSize: "var(--text-caption)"
		} }, "Couldn’t send");
		return null;
	}
	function Action({ action, send }) {
		if (action.type === "link-button") return /* @__PURE__ */ React.createElement(ExternalLink, { url: action.url }, action.label);
		if (action.type === "button") return /* @__PURE__ */ React.createElement(ButtonView, {
			button: action,
			send
		});
		return /* @__PURE__ */ React.createElement(SelectView, {
			select: action,
			send
		});
	}
	function ButtonView({ button, send }) {
		const sender = useSender(send);
		const style = button.style === "primary" ? {
			background: "var(--accent)",
			color: "var(--text-on-accent)"
		} : button.style === "danger" ? { color: "var(--text-danger)" } : {};
		return /* @__PURE__ */ React.createElement("span", { style: {
			display: "inline-flex",
			alignItems: "center",
			gap: "var(--space-1)"
		} }, /* @__PURE__ */ React.createElement("button", {
			type: "button",
			style,
			disabled: button.disabled || sender.disabled,
			onClick: () => sender.run(button.id, button.value, button.label)
		}, button.label), /* @__PURE__ */ React.createElement(Status, { state: sender.state }));
	}
	function SelectView({ select, send }) {
		const sender = useSender(send);
		const choose = (value) => {
			const option = select.options.find((o) => o.value === value);
			if (option) sender.run(select.id, option.value, `${select.label}: ${option.label}`);
		};
		if (select.type === "radio_select") return /* @__PURE__ */ React.createElement("fieldset", {
			style: {
				border: 0,
				padding: 0,
				margin: 0
			},
			disabled: sender.disabled
		}, /* @__PURE__ */ React.createElement("legend", null, select.label), select.options.map((o) => /* @__PURE__ */ React.createElement("label", {
			key: o.value,
			style: { display: "block" }
		}, /* @__PURE__ */ React.createElement("input", {
			type: "radio",
			name: select.id,
			defaultChecked: o.value === select.initialOption,
			onChange: () => choose(o.value)
		}), " ", o.label)), /* @__PURE__ */ React.createElement(Status, { state: sender.state }));
		return /* @__PURE__ */ React.createElement("label", { style: {
			display: "inline-flex",
			alignItems: "center",
			gap: "var(--space-1)"
		} }, select.label, /* @__PURE__ */ React.createElement("select", {
			defaultValue: select.initialOption ?? "",
			disabled: sender.disabled,
			onChange: (e) => choose(e.currentTarget.value)
		}, /* @__PURE__ */ React.createElement("option", {
			value: "",
			disabled: true
		}, select.placeholder ?? "Choose…"), select.options.map((o) => /* @__PURE__ */ React.createElement("option", {
			key: o.value,
			value: o.value
		}, o.label))), /* @__PURE__ */ React.createElement(Status, { state: sender.state }));
	}
	function TextInputView({ input }) {
		const inputs = useContext(InputsContext);
		const [text, setText] = useState(input.initialValue ?? "");
		const change = (e) => {
			setText(e.currentTarget.value);
			inputs[input.id] = e.currentTarget.value;
		};
		const field = {
			value: text,
			placeholder: input.placeholder,
			onChange: change,
			style: { width: "100%" }
		};
		return /* @__PURE__ */ React.createElement("label", { style: {
			display: "flex",
			flexDirection: "column",
			gap: "var(--space-1)"
		} }, input.label, input.multiline ? /* @__PURE__ */ React.createElement("textarea", {
			rows: 3,
			...field
		}) : /* @__PURE__ */ React.createElement("input", {
			type: "text",
			...field
		}));
	}
	function CardMessage({ message }) {
		const session = useSession();
		const inputs = useRef({}).current;
		const parsed = parseCardMessage(message.content);
		if (!parsed || parsed.status === "invalid") return /* @__PURE__ */ React.createElement("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: "var(--space-1)"
		} }, parsed?.before ? /* @__PURE__ */ React.createElement(Prose, { content: parsed.before }) : null, /* @__PURE__ */ React.createElement("p", { style: {
			margin: 0,
			color: "var(--text-subtle)",
			fontSize: "var(--text-caption)"
		} }, "This card can’t be shown. ", parsed?.status === "invalid" ? parsed.reason : ""));
		for (const id of inputIds(parsed.card.children)) inputs[id.id] ??= id.initialValue ?? "";
		const send = session ? async (action, value, label) => {
			const values = Object.keys(inputs).length ? { ...inputs } : void 0;
			const content = formatAction({
				message: message.id,
				action,
				...value === void 0 ? {} : { value },
				...values ? { values } : {}
			}, label);
			session.messages.reply(message.channelId, message.threadRootId ?? message.id, content, [message.authorId]);
		} : null;
		return /* @__PURE__ */ React.createElement(InputsContext.Provider, { value: inputs }, /* @__PURE__ */ React.createElement("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: "var(--space-2)"
		} }, /* @__PURE__ */ React.createElement(CardView, {
			card: parsed.card,
			send
		}), parsed.after ? /* @__PURE__ */ React.createElement(Prose, { content: parsed.after }) : null));
	}
	function ActionMessage({ message }) {
		const action = parseAction(message.content);
		return /* @__PURE__ */ React.createElement("p", { style: {
			margin: 0,
			color: "var(--text-subtle)"
		} }, "Chose ", /* @__PURE__ */ React.createElement("strong", { style: { color: "var(--text-standard)" } }, action?.label || action?.action));
	}
	ctx.conversation.registerMessage({
		id: "card",
		title: "Chat card",
		matches: (message) => hasCard(message.content),
		component: CardMessage
	});
	ctx.conversation.registerMessage({
		id: "card-action",
		title: "Chat card choice",
		matches: (message) => parseAction(message.content) !== null,
		component: ActionMessage
	});
}
export { apply, inject };
