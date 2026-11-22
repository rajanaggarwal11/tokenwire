#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { diffSnapshots } from "./diff.js";
import { addTurn, incompleteOf, lintExchanges, lintTurns } from "./lint.js";
import { renderDiffMarkdown, renderDiffText } from "./render-diff.js";
import { DEFAULT_SNAPSHOT, fromSession, loadSnapshot, writeSnapshot } from "./snapshot.js";
import { startProxy } from "./proxy.js";
import { renderFindings, renderIncomplete, renderReport, renderSummary, toJson } from "./report.js";
import { ALL_RULES, RULE_IDS } from "./rules/index.js";
import type { Finding, RuleId } from "./rules/index.js";
import { fmt } from "./rules/types.js";
import { appendExchange, DEFAULT_SESSION, readSession } from "./session.js";
import type { Turn } from "./rules/index.js";
import type { Exchange } from "./types.js";
import { VERSION } from "./version.js";

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_ERROR = 2;

const HELP = `
tokenwire — see what your app sends to Anthropic or OpenAI, and lint it

Usage
  tokenwire wrap [options] -- <command> [args…]   Run a command through the proxy, then report
  tokenwire [options]                              Start the proxy and report live (Ctrl-C to finish)
  tokenwire report [session] [options]             Report on a recorded session
  tokenwire check [session] [options]              Lint a recorded session for CI — exit 0/1/2
  tokenwire snapshot [session] [-o file]           Save what a session sends, small enough to commit
  tokenwire diff <base> [head] [options]           Compare two snapshots or sessions — exit 0/1/2

In CI
  tokenwire wrap --offline -- npm run scenario     Record what your app sends, without sending it
  tokenwire diff tokenwire.snapshot.json --format markdown >> "$GITHUB_STEP_SUMMARY"
  tokenwire snapshot                               Accept the change: rewrite the committed snapshot

Proxy options
  --port <n>              Listen on this port (default: a free one)
  --upstream <name=url>   Add or replace an upstream; repeatable (default: anthropic, openai)
  --session <file>        Where to record (default: ${DEFAULT_SESSION}); --no-record keeps nothing
  --append                Keep an existing session file instead of starting fresh
  --offline               Answer chat requests locally instead of forwarding them: the request is
                          recorded exactly, nothing leaves the machine, no API key, no cost
  --reply <text>          With --offline: the assistant text every request gets back (default: empty)

Diff options
  --max-increase <n|n%>   Fail when input tokens per run grow by more than this (e.g. 2k or 10%)
  --price <usd>           Your USD per million input tokens, for a cost line (offline counts
                          are o200k estimates, so the cost is too)
  --runs-per-day <n>      With --price: how often the scenario runs in production
  --format <f>            text (default), markdown (for a PR comment or job summary), or json
  -o, --output <file>     snapshot: where to write (default: ${DEFAULT_SNAPSHOT})

Lint options
  --budget <n>            Input tokens per request above which 'budget' fires
  --max-growth <pct>      Median growth per turn above which 'growth' fires (default 10)
  --window <n>            Context window for the growth projection (default: from the model)
  --only <ids>            Run only these rules (comma-separated)
  --ignore <ids>          Skip these rules (comma-separated)
  --strict                Exit 1 on warnings too
  --json                  Machine-readable output (stable shape, version 1)
  --sections              Also print every section of the last request, largest first
  --list-rules            Print every rule and what it checks
  -v, --version           Print the version
  -h, --help              Print this

The proxy never modifies a request or a response.
The record never contains a credential: every authorization, api-key and
cookie header is stripped before an exchange is written.
Point an SDK at it with the two variables it prints.

Exit codes
  0  nothing to report (for 'wrap': the command succeeded and nothing to report)
  1  findings remain — errors, or warnings under --strict; for 'diff': over --max-increase,
     or the change breaks prompt caching
  2  could not run — no session, unknown command or option, upstream unreachable
`.trimStart();

const COMMANDS = ["wrap", "report", "check", "snapshot", "diff"] as const;

/** Edit distance, for "did you mean". Commands are short; the quadratic table is fine. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length]!;
}

function closest(word: string, options: readonly string[]): string | undefined {
  const w = word.toLowerCase();
  // A prefix says more than an edit distance: "snap" is short for "snapshot", not a typo of "wrap".
  const prefixed = options.filter((o) => o.startsWith(w) || w.startsWith(o));
  if (prefixed.length === 1) return prefixed[0];
  let best: { option: string; d: number } | undefined;
  for (const option of options) {
    const d = distance(w, option);
    if (!best || d < best.d) best = { option, d };
  }
  return best && best.d <= Math.max(1, Math.floor(best.option.length / 2))
    ? best.option
    : undefined;
}

interface Parsed {
  command: "proxy" | "wrap" | "report" | "check" | "snapshot" | "diff";
  positionals: string[];
  child: string[];
  values: Record<string, string | boolean | string[] | undefined>;
}

function parse(argv: string[]): Parsed {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const child = sep === -1 ? [] : argv.slice(sep + 1);
  const { values, positionals } = parseArgs({
    args: own,
    strict: true,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      upstream: { type: "string", multiple: true },
      session: { type: "string" },
      "no-record": { type: "boolean" },
      append: { type: "boolean" },
      offline: { type: "boolean" },
      reply: { type: "string" },
      "max-increase": { type: "string" },
      price: { type: "string" },
      "runs-per-day": { type: "string" },
      format: { type: "string" },
      output: { type: "string", short: "o" },
      budget: { type: "string" },
      "max-growth": { type: "string" },
      window: { type: "string" },
      only: { type: "string" },
      ignore: { type: "string" },
      strict: { type: "boolean" },
      json: { type: "boolean" },
      "list-rules": { type: "boolean" },
      sections: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  const first = positionals[0];
  // No command starts the proxy. Anything else must be a command: a typo such as
  // "tokenwire chek" would otherwise start a proxy that never exits, and empty the
  // session file the user meant to check.
  if (first !== undefined && !(COMMANDS as readonly string[]).includes(first)) {
    const near = closest(first, COMMANDS);
    throw new UsageError(
      `unknown command "${first}".${near ? ` Did you mean "${near}"?` : ""} Commands: ${COMMANDS.join(", ")}. ` +
        "Run 'tokenwire' with no command to start the proxy, or 'tokenwire --help'.",
    );
  }
  const command = (first as (typeof COMMANDS)[number] | undefined) ?? "proxy";
  // "tokenwire -- node app.js" forgot the command: without this it starts a proxy that
  // never exits, and empties the session file.
  if (child.length && command !== "wrap")
    throw new UsageError(
      `only 'wrap' runs a command. Did you mean: tokenwire wrap ${own.join(" ")}${own.length ? " " : ""}-- ${child.join(" ")}`,
    );
  return {
    command,
    positionals: command === "proxy" ? positionals : positionals.slice(1),
    child,
    values: values as Parsed["values"],
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function rules(v: unknown, flag: string): RuleId[] | undefined {
  const s = str(v);
  if (!s) return undefined;
  const ids = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const id of ids)
    if (!RULE_IDS.includes(id as RuleId))
      throw new UsageError(`unknown rule "${id}" in ${flag}. Rules: ${RULE_IDS.join(", ")}`);
  return ids as RuleId[];
}

function int(v: unknown, flag: string): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  // 40000, 40_000, 40,000, 40k, 1.5k, 1m. The suffix multiplies; replacing "k"
  // with "000" as text would read 1.5k as 1.5.
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(s.replace(/[_,]/g, "").trim());
  if (!m) throw new UsageError(`${flag} expects a number like 40000, 40k or 1.5m, got "${s}"`);
  const scale = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
  return Math.round(Number(m[1]) * scale);
}

class UsageError extends Error {}

function lintOptions(p: Parsed) {
  return {
    only: rules(p.values.only, "--only"),
    ignore: rules(p.values.ignore, "--ignore"),
    budget: int(p.values.budget, "--budget"),
    maxGrowthPct: int(p.values["max-growth"], "--max-growth"),
    window: int(p.values.window, "--window"),
  };
}

function exitFor(findings: Finding[], strict: boolean): number {
  if (findings.some((f) => f.severity === "error")) return EXIT_FINDINGS;
  if (strict && findings.some((f) => f.severity === "warn")) return EXIT_FINDINGS;
  return EXIT_OK;
}

function upstreams(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of Array.isArray(v) ? v : []) {
    const [name, ...rest] = String(item).split("=");
    const url = rest.join("=");
    if (!name || !url) throw new UsageError(`--upstream expects name=url, got "${item}"`);
    out[name] = url;
  }
  return out;
}

function listRules(): string {
  const w = Math.max(...ALL_RULES.map((r) => r.id.length));
  return (
    ALL_RULES.map(
      (r) =>
        `${pc.bold(r.id.padEnd(w))}  ${pc.dim(r.defaultSeverity.padEnd(5))}  ${r.title}\n${" ".repeat(w + 9)}${pc.dim(r.description)}`,
    ).join("\n") + "\n"
  );
}

const oneLine = (x: Exchange, n: number): string => {
  const u = x.response.usage;
  const tokens =
    x.kind === "other"
      ? pc.dim("not a chat request")
      : u.source === "provider"
        ? `${fmt(u.input)} in${u.cacheRead ? pc.dim(` (${fmt(u.cacheRead)} cached)`) : ""} · ${fmt(u.output)} out`
        : pc.dim("no usage in response");
  const status = x.error
    ? pc.red(`✗ ${x.error}`)
    : x.response.status >= 400
      ? pc.red(String(x.response.status))
      : pc.green(String(x.response.status));
  return `  ${pc.dim(`#${n}`)} ${x.method} ${x.upstream}${x.path.split("?")[0]} ${pc.dim(x.model ?? "")} ${status} ${tokens} ${pc.dim(`${(x.durationMs / 1000).toFixed(1)}s`)}`;
};

async function runProxy(p: Parsed, wrap: boolean): Promise<number> {
  const sessionPath = p.values["no-record"]
    ? undefined
    : resolve(str(p.values.session) ?? DEFAULT_SESSION);
  const exchanges: Exchange[] = [];
  // Built once per exchange as it arrives; re-parsing the whole session on every request
  // made live mode quadratic.
  const turns: Turn[] = [];
  const incomplete: string[] = [];
  const seen = new Set<string>();
  const opts = lintOptions(p);
  const out = (s: string) => process.stderr.write(s);

  const offline = !!p.values.offline;
  if (!offline && p.values.reply !== undefined)
    throw new UsageError("--reply only applies with --offline");
  const proxy = await startProxy({
    port: int(p.values.port, "--port"),
    upstreams: upstreams(p.values.upstream),
    ...(offline ? { offline: { reply: str(p.values.reply) ?? "" } } : {}),
    onExchange: (x) => {
      exchanges.push(x);
      addTurn(turns, x);
      if (sessionPath) appendExchange(sessionPath, x);
      out(oneLine(x, exchanges.length) + "\n");
      const gaps = incompleteOf(x, exchanges.length);
      incomplete.push(...gaps);
      if (gaps.length) out(renderIncomplete(gaps));
      // Live: only findings that are new since the last request.
      const fresh = lintTurns(turns, opts).findings.filter((f) => {
        const key = `${f.rule}|${f.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length) out(renderFindings(fresh));
    },
  });
  // Only now that the proxy is up: a bad option must not cost the user their last session.
  if (sessionPath && !p.values.append) writeFileSync(sessionPath, "");

  const finish = async (): Promise<number> => {
    // The last exchange is recorded after the client has its bytes; give it a beat.
    await new Promise((r) => setTimeout(r, 250));
    await proxy.close();
    const result = lintTurns(turns, opts, incomplete);
    const title = sessionPath ?? "not recorded";
    if (p.values.json) process.stdout.write(JSON.stringify(toJson(result, title), null, 2) + "\n");
    else process.stdout.write("\n" + renderReport(result, title, !!p.values.sections));
    if (offline && wrap && result.turns.length === 0) {
      // An offline capture that captured nothing measured nothing; passing would hide it.
      out(
        pc.red(
          "✗ --offline recorded no chat requests. Does the command call an LLM, and does its SDK read ANTHROPIC_BASE_URL / OPENAI_BASE_URL?\n",
        ),
      );
      return EXIT_ERROR;
    }
    return exitFor(result.findings, !!p.values.strict);
  };

  if (wrap) {
    const [cmd, ...args] = p.child;
    if (!cmd)
      throw new UsageError("wrap needs a command after --, e.g. tokenwire wrap -- node agent.js");
    out(
      pc.dim(
        `tokenwire · ${offline ? "offline capture — nothing is sent upstream" : `proxy on ${proxy.url}`} · ANTHROPIC_BASE_URL and OPENAI_BASE_URL set for: ${[cmd, ...args].join(" ")}\n`,
      ),
    );
    const code = await new Promise<number>((resolveCode) => {
      const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...proxy.env } });
      // SIGTERM and SIGHUP from CI, a supervisor or a closed terminal are sent to
      // tokenwire alone: pass them on. Ctrl-C is different: the terminal already sends
      // SIGINT to the whole process group, the command included, so forwarding it would
      // deliver it twice (and a second Ctrl-C means "force quit" to many tools). On
      // SIGINT tokenwire only stays alive, to report once the command has finished.
      const forward = (signal: NodeJS.Signals) => child.kill(signal);
      const forwarded = ["SIGTERM", "SIGHUP"] as const;
      const survive = () => {};
      for (const s of forwarded) process.on(s, forward);
      process.on("SIGINT", survive);
      const done = (c: number) => {
        for (const s of forwarded) process.off(s, forward);
        process.off("SIGINT", survive);
        resolveCode(c);
      };
      child.on("error", (err) => {
        out(pc.red(`✗ could not start ${cmd}: ${err.message}\n`));
        done(EXIT_ERROR);
      });
      // Killed by a signal: the shell convention, 128 + the signal's number.
      child.on("exit", (c, signal) =>
        done(c ?? (signal ? 128 + (constants.signals[signal] ?? 0) : EXIT_ERROR)),
      );
    });
    const lintCode = await finish();
    return code !== 0 ? code : lintCode;
  }

  out(
    `${pc.bold("tokenwire")} ${pc.dim(`· proxy on ${proxy.url} · recording to ${sessionPath ?? "nowhere (--no-record)"}`)}\n\n` +
      `  export ANTHROPIC_BASE_URL=${proxy.env.ANTHROPIC_BASE_URL}\n  export OPENAI_BASE_URL=${proxy.env.OPENAI_BASE_URL}\n\n` +
      pc.dim("  Run your app in another shell. Ctrl-C here for the report.\n\n"),
  );
  return new Promise((resolveCode) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      finish().then(resolveCode, () => resolveCode(EXIT_ERROR));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function runOnSession(p: Parsed): number {
  const file = p.positionals[0] ?? DEFAULT_SESSION;
  const path = resolve(file);
  if (!existsSync(path))
    throw new UsageError(
      `no session file at ${file}. Record one with 'tokenwire wrap -- <command>'.`,
    );
  const result = lintExchanges(readSession(path), lintOptions(p));
  if (p.values.json) process.stdout.write(JSON.stringify(toJson(result, file), null, 2) + "\n");
  else if (p.command === "report")
    process.stdout.write(renderReport(result, file, !!p.values.sections));
  else
    process.stdout.write(
      renderIncomplete(result.incomplete) +
        renderFindings(result.findings) +
        renderSummary(result.findings),
    );
  return exitFor(result.findings, !!p.values.strict);
}

function number(v: unknown, flag: string): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = s.trim().replace(/^\$/, "");
  const n = t === "" ? NaN : Number(t);
  if (!Number.isFinite(n) || n < 0)
    throw new UsageError(`${flag} expects a non-negative number, got "${s}"`);
  return n;
}

function runSnapshot(p: Parsed): number {
  const file = p.positionals[0] ?? DEFAULT_SESSION;
  if (!existsSync(resolve(file)))
    throw new UsageError(
      `no session file at ${file}. Record one with 'tokenwire wrap --offline -- <command>'.`,
    );
  const snapshot = fromSession(readSession(resolve(file)));
  const { turns } = snapshot;
  if (!turns.length) throw new UsageError(`${file} has no chat requests to snapshot`);
  const out = str(p.values.output) ?? DEFAULT_SNAPSHOT;
  writeSnapshot(resolve(out), snapshot);
  const total = turns.reduce((a, t) => a + t.totalTokens, 0);
  process.stderr.write(renderIncomplete(snapshot.incomplete ?? []));
  process.stderr.write(
    `${pc.green("✓")} wrote ${out} — ${turns.length} request${turns.length === 1 ? "" : "s"}, ${fmt(total)} input tokens per run\n`,
  );
  return EXIT_OK;
}

function runDiff(p: Parsed): number {
  if (p.positionals.length > 2)
    throw new UsageError(
      `diff takes a baseline and at most one more file, got: ${p.positionals.join(" ")}. Quote option values with spaces ("10%", not 10 %).`,
    );
  const [baseFile, headFile = DEFAULT_SESSION] = p.positionals;
  if (!baseFile)
    throw new UsageError("diff needs a baseline: tokenwire diff tokenwire.snapshot.json [session]");
  const limit = str(p.values["max-increase"]);
  const pctLimit = limit?.trim().endsWith("%")
    ? number(limit.trim().slice(0, -1), "--max-increase")
    : undefined;
  const tokenLimit =
    limit !== undefined && pctLimit === undefined ? int(limit, "--max-increase") : undefined;
  const runsPerDay = int(p.values["runs-per-day"], "--runs-per-day");
  const price = number(p.values.price, "--price");
  if (runsPerDay !== undefined && price === undefined)
    throw new UsageError("--runs-per-day needs --price");
  const format = str(p.values.format) ?? (p.values.json ? "json" : "text");
  if (!["text", "markdown", "json"].includes(format))
    throw new UsageError(`--format expects text, markdown or json, got "${format}"`);

  const base = loadSnapshot(resolve(baseFile));
  const head = loadSnapshot(resolve(headFile), "all");
  // A run that recorded nothing would diff as a huge saving and pass. Measuring nothing
  // is a broken check, not a good result.
  for (const [file, s] of [
    [baseFile, base],
    [headFile, head],
  ] as const) {
    if (!s.turns.length)
      throw new UsageError(
        `${file} has no chat requests. Did the scenario run under 'tokenwire wrap', and does its SDK read ANTHROPIC_BASE_URL / OPENAI_BASE_URL?`,
      );
  }
  const diff = diffSnapshots(base, head, {
    ...(pctLimit !== undefined ? { maxIncreasePct: pctLimit } : {}),
    ...(tokenLimit !== undefined ? { maxIncreaseTokens: tokenLimit } : {}),
    ...(price !== undefined ? { pricePerMTok: price } : {}),
    ...(runsPerDay !== undefined ? { runsPerDay } : {}),
  });
  if (format === "json")
    process.stdout.write(JSON.stringify({ version: 1, ...diff }, null, 2) + "\n");
  else if (format === "markdown") process.stdout.write(renderDiffMarkdown(diff));
  else process.stdout.write(renderDiffText(diff));
  return diff.failures.length ? EXIT_FINDINGS : EXIT_OK;
}

export async function run(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
    if (p.values.help) {
      process.stdout.write(HELP);
      return EXIT_OK;
    }
    if (p.values.version) {
      process.stdout.write(`${VERSION}\n`);
      return EXIT_OK;
    }
    if (p.values["list-rules"]) {
      process.stdout.write(listRules());
      return EXIT_OK;
    }
    if (p.command === "report" || p.command === "check") return runOnSession(p);
    if (p.command === "snapshot") return runSnapshot(p);
    if (p.command === "diff") return runDiff(p);
    return await runProxy(p, p.command === "wrap");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${pc.red("✗")} ${msg}\n`);
    return EXIT_ERROR;
  }
}

/** npm installs the bin as a symlink, so both sides are resolved before comparing. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT_ERROR);
    },
  );
}
