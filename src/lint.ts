import { contextOf } from "./context.js";
import { ALL_RULES } from "./rules/index.js";
import type { Finding, RuleId, RuleOptions, Turn } from "./rules/index.js";
import type { Exchange } from "./types.js";

export interface LintOptions extends RuleOptions {
  only?: RuleId[];
  ignore?: RuleId[];
}

export interface LintResult {
  turns: Turn[];
  findings: Finding[];
  rulesRun: RuleId[];
  /**
   * Exchanges the record could not keep whole (a body over the record limit), and what
   * that leaves out. Not findings about the app: gaps in what was linted.
   */
  incomplete: string[];
}

/** The context-bearing requests of a session, numbered from 1. */
export function turnsOf(exchanges: Exchange[]): Turn[] {
  const turns: Turn[] = [];
  for (const exchange of exchanges) addTurn(turns, exchange);
  return turns;
}

/** Appends the exchange to `turns` when it is a chat request. Live mode builds turns this way, once each. */
export function addTurn(turns: Turn[], exchange: Exchange): void {
  const context = contextOf(exchange);
  if (context) turns.push({ n: turns.length + 1, exchange, context });
}

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** What a record too large to keep whole leaves out, for one exchange (n is 1-based). */
export function incompleteOf(exchange: Exchange, n: number): string[] {
  const where = `#${n} ${exchange.method} ${exchange.upstream}${exchange.path.split("?")[0]}`;
  const out: string[] = [];
  if (exchange.request.truncated)
    out.push(
      `${where}: the request body was ${MB(exchange.request.bytes)}, more than the record keeps, so this request is not linted or counted`,
    );
  if (exchange.response.truncated)
    out.push(
      `${where}: the response body was ${MB(exchange.response.bytes)}, more than the record keeps, so its usage and tool calls are unknown`,
    );
  return out;
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export function lintExchanges(exchanges: Exchange[], options: LintOptions = {}): LintResult {
  return lintTurns(
    turnsOf(exchanges),
    options,
    exchanges.flatMap((x, i) => incompleteOf(x, i + 1)),
  );
}

/** Lints turns already built: live mode keeps them as exchanges arrive instead of re-parsing every one. */
export function lintTurns(
  turns: Turn[],
  options: LintOptions = {},
  incomplete: string[] = [],
): LintResult {
  const rules = ALL_RULES.filter(
    (r) => (!options.only || options.only.includes(r.id)) && !options.ignore?.includes(r.id),
  );
  const findings = rules
    .flatMap((r) => r.check(turns, options))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.turn ?? 0) - (b.turn ?? 0),
    );
  return { turns, findings, rulesRun: rules.map((r) => r.id), incomplete };
}
