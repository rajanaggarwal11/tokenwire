import pc from "picocolors";
import type { CacheBreak, Diff, TextChange, ToolChange } from "./diff.js";
import { VERSION } from "./version.js";

const fmt = (n: number) => n.toLocaleString("en-US");
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "0");
const pctText = (p: number | null) =>
  p === null ? "" : ` (${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%)`;
const usd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toFixed(4);
  return `${n < 0 ? "−" : n > 0 ? "+" : ""}$${s}`;
};
/** Show whitespace and keep a quote on one line. */
const quote = (s: string, max = 60) => {
  const one = s.replace(/\n/g, "⏎").replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/** Marks the comment so the action can update it in place instead of posting another. */
export const COMMENT_MARKER = "<!-- tokenwire-diff -->";

function changeLine(c: TextChange): string {
  if (c.redacted)
    return c.was.startsWith("[")
      ? `changed inside ${c.was} at char ${fmt(c.at)}`
      : `changed inside ${c.was}, the first at char ${fmt(c.at)}`;
  const what = c.volatile ? "a value that changes every run" : "changed";
  return `${what} at char ${fmt(c.at)}: "${quote(c.was)}" → "${quote(c.now)}"`;
}

function breakLine(b: CacheBreak): string {
  // Only the system prompt and tool definitions are quoted; conversation text never is.
  const q = b.redacted
    ? b.was?.startsWith("[")
      ? `, inside ${b.was} at char ${fmt(b.at)}`
      : `, inside ${b.was ?? "a redacted secret"}, the first at char ${fmt(b.at)}`
    : b.inPrefix && b.was !== undefined && b.now !== undefined
      ? `, char ${fmt(b.at)}: "${quote(b.was)}" → "${quote(b.now)}"`
      : "";
  const why = b.volatile ? " (a timestamp or id rendered in on every request)" : "";
  return `request ${b.turn} stops repeating request ${b.previous} at ${b.where}${q}${why} — ${fmt(b.tokens)} tokens from there on can't be served from cache`;
}

/** Lines for the cache section: new breaks, breaks that were already there, fixed ones. */
function cacheLines(d: Diff): { icon: "bad" | "warn" | "good"; text: string }[] {
  const lines: { icon: "bad" | "warn" | "good"; text: string }[] = [];
  const introduced = new Set(d.cache.introduced.map((b) => b.key));
  for (const b of d.cache.introduced) lines.push({ icon: "bad", text: breakLine(b) });
  for (const b of d.head.cacheBreaks.filter((x) => !introduced.has(x.key)))
    lines.push({ icon: "warn", text: `already broken before this change: ${breakLine(b)}` });
  for (const b of d.cache.fixed)
    lines.push({ icon: "good", text: `fixed: ${b.where} now repeats cleanly` });
  if (!d.head.cacheBreaks.length && !d.cache.fixed.length)
    lines.push({
      icon: "good",
      text:
        d.head.turns > 1
          ? `every request repeats the one it continues (${d.head.turns} requests)`
          : "no break within the run (one request — nothing to compare across)",
    });
  if (d.cache.volatile)
    lines.push({
      icon: "warn",
      text: `the system prompt contains ${changeLine(d.cache.volatile)}. Everything after it is re-sent uncached on every run; move it to the end of the prompt or into the first message.`,
    });
  return lines;
}

function toolRow(t: ToolChange, kind: "added" | "removed" | "changed"): [string, string] {
  if (kind === "added") return [`\`${t.name}\``, `+${fmt(t.head ?? 0)}`];
  if (kind === "removed") return [`\`${t.name}\``, `−${fmt(t.base ?? 0)}`];
  const d = (t.head ?? 0) - (t.base ?? 0);
  return [`\`${t.name}\``, t.textChanged ? "reworded, same size" : signed(d)];
}

function estimateNote(d: Diff): string {
  const offline = d.head.offline || d.base.offline;
  const exact = d.head.exact && d.base.exact;
  if (exact) return "counts from provider usage";
  return offline
    ? "captured offline: answered locally, not by a provider; counts are tokenizer estimates (o200k)"
    : "counts are tokenizer estimates (o200k), calibrated where the provider reported usage";
}

/** Said next to every dollar figure that rests on a tokenizer estimate. */
function costCaveat(d: Diff): string {
  if (d.head.exact && d.base.exact) return "";
  return "estimated: o200k token counts, which is OpenAI's tokenizer, so Claude models will differ";
}

/** The PR comment. */
export function renderDiffMarkdown(d: Diff, title = "what this change sends the model"): string {
  const L: string[] = [COMMENT_MARKER, `### tokenwire · ${title}`, ""];
  const verdict = d.failures.length
    ? `❌ ${d.failures.join("; ")}`
    : d.delta.tokens === 0 &&
        !d.tools.added.length &&
        !d.tools.removed.length &&
        !d.tools.changed.length &&
        !d.system.change
      ? "✅ No change to what is sent."
      : "✅ Within limits.";
  L.push(verdict, "");
  for (const w of d.warnings) L.push(`> ⚠️ ${w}`, "");

  L.push("| | base | this change | Δ |", "| --- | ---: | ---: | ---: |");
  L.push(
    `| **Input tokens per run** | ${fmt(d.base.inputTokens)} | ${fmt(d.head.inputTokens)} | **${signed(d.delta.tokens)}${pctText(d.delta.pct)}** |`,
  );
  L.push(
    `| System prompt | ${fmt(d.base.system)} | ${fmt(d.head.system)} | ${signed(d.head.system - d.base.system)} |`,
  );
  L.push(
    `| Tool definitions (${d.base.toolCount} → ${d.head.toolCount}) | ${fmt(d.base.tools)} | ${fmt(d.head.tools)} | ${signed(d.head.tools - d.base.tools)} |`,
  );
  L.push(
    `| First message | ${fmt(d.base.conversation)} | ${fmt(d.head.conversation)} | ${signed(d.head.conversation - d.base.conversation)} |`,
  );
  if (d.base.turns !== d.head.turns || d.base.turns > 1)
    L.push(
      `| Requests per run | ${d.base.turns} | ${d.head.turns} | ${signed(d.head.turns - d.base.turns)} |`,
    );
  L.push("");

  const tools = [
    ...d.tools.added.map((t) => ["➕", ...toolRow(t, "added")]),
    ...d.tools.removed.map((t) => ["➖", ...toolRow(t, "removed")]),
    ...d.tools.changed.map((t) => ["✏️", ...toolRow(t, "changed")]),
  ];
  if (tools.length) {
    L.push("**Tools**", "", "| | tool | tokens |", "| --- | --- | ---: |");
    for (const [icon, name, tok] of tools.slice(0, 15)) L.push(`| ${icon} | ${name} | ${tok} |`);
    if (tools.length > 15) L.push(`| | …and ${tools.length - 15} more | |`);
    L.push("");
  }

  if (d.system.change && !d.system.change.volatile)
    L.push(`**System prompt** ${changeLine(d.system.change)}`, "");

  L.push("**Prompt caching**", "");
  const icons = { bad: "❌", warn: "⚠️", good: "✅" };
  for (const line of cacheLines(d)) L.push(`- ${icons[line.icon]} ${line.text}`);
  L.push("");

  if (d.cost) {
    const per = `at $${d.cost.pricePerMTok}/MTok input`;
    const caveat = costCaveat(d);
    L.push(
      (d.cost.perDayUsd !== undefined
        ? `**Cost** ${usd(d.cost.perDayUsd)}/day, ${usd(d.cost.perDayUsd * 30)}/month — ${fmt(d.cost.runsPerDay!)} runs/day ${per}`
        : `**Cost** ${usd(d.cost.perRunUsd)} per run ${per}`) + (caveat ? ` (${caveat})` : ""),
      "",
    );
  }

  if (d.turns.length > 1) {
    L.push(
      "<details><summary>Per request</summary>",
      "",
      "| request | base | this change | Δ |",
      "| ---: | ---: | ---: | ---: |",
    );
    for (const t of d.turns.slice(0, 30))
      L.push(
        `| ${t.n} | ${t.base === undefined ? "—" : fmt(t.base)} | ${t.head === undefined ? "—" : fmt(t.head)} | ${signed((t.head ?? 0) - (t.base ?? 0))} |`,
      );
    L.push("", "</details>", "");
  }

  L.push(
    `<sub>[tokenwire](https://github.com/rajanaggarwal11/tokenwire) ${VERSION} · ${estimateNote(d)}</sub>`,
  );
  return L.join("\n") + "\n";
}

/** The same, for a terminal. */
export function renderDiffText(d: Diff): string {
  const L: string[] = [];
  const head = `${fmt(d.base.inputTokens)} → ${fmt(d.head.inputTokens)} input tokens per run`;
  const delta = `${signed(d.delta.tokens)}${pctText(d.delta.pct)}`;
  const color = d.delta.tokens > 0 ? pc.yellow : d.delta.tokens < 0 ? pc.green : pc.dim;
  L.push(`${pc.bold("tokenwire diff")}  ${head}  ${color(delta)}`, "");
  const row = (label: string, b: number, h: number) =>
    `  ${label.padEnd(26)} ${fmt(b).padStart(9)} → ${fmt(h).padStart(9)}  ${signed(h - b).padStart(8)}`;
  L.push(row("system prompt", d.base.system, d.head.system));
  L.push(
    row(`tool definitions (${d.base.toolCount} → ${d.head.toolCount})`, d.base.tools, d.head.tools),
  );
  L.push(row("first message", d.base.conversation, d.head.conversation));
  for (const t of d.tools.added)
    L.push(`    ${pc.green("+")} ${t.name} ${pc.dim(`+${fmt(t.head ?? 0)}`)}`);
  for (const t of d.tools.removed)
    L.push(`    ${pc.red("−")} ${t.name} ${pc.dim(`−${fmt(t.base ?? 0)}`)}`);
  for (const t of d.tools.changed)
    L.push(
      `    ${pc.yellow("~")} ${t.name} ${pc.dim(t.textChanged ? "reworded" : signed((t.head ?? 0) - (t.base ?? 0)))}`,
    );
  if (d.system.change && !d.system.change.volatile)
    L.push(`  system prompt ${changeLine(d.system.change)}`);
  L.push("");
  const marks = { bad: pc.red("✗"), warn: pc.yellow("!"), good: pc.green("✓") };
  for (const line of cacheLines(d)) L.push(`${marks[line.icon]} cache: ${line.text}`);
  for (const w of d.warnings) L.push(`${pc.yellow("!")} ${w}`);
  if (d.cost) {
    const caveat = costCaveat(d);
    L.push(
      (d.cost.perDayUsd !== undefined
        ? `  cost ${usd(d.cost.perDayUsd)}/day at ${fmt(d.cost.runsPerDay!)} runs/day, $${d.cost.pricePerMTok}/MTok`
        : `  cost ${usd(d.cost.perRunUsd)} per run at $${d.cost.pricePerMTok}/MTok`) +
        (caveat ? pc.dim(` (${caveat})`) : ""),
    );
  }
  L.push("");
  if (d.failures.length) for (const f of d.failures) L.push(`${pc.red("✗")} ${f}`);
  else L.push(pc.green("✓ within limits"));
  L.push(pc.dim(estimateNote(d)));
  return L.join("\n") + "\n";
}
