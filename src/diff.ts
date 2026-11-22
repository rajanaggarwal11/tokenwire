import { REDACTED } from "./rules/patterns.js";
import type { Snapshot, SnapshotSection, SnapshotTurn } from "./snapshot.js";

/** First index at which two strings differ, or -1 when equal. */
export function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** The changed span of two strings: from the first difference to the last. */
export function changedSpan(a: string, b: string): { at: number; was: string; now: string } | null {
  const at = firstDiff(a, b);
  if (at === -1) return null;
  let tail = 0;
  while (
    tail < a.length - at &&
    tail < b.length - at &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return { at, was: a.slice(at, a.length - tail), now: b.slice(at, b.length - tail) };
}

const WORD = /[A-Za-z0-9:.\-+/_]/;
/** The whole token around [start, end) — so "39.785" is read as part of its timestamp. */
function tokenAround(text: string, start: number, end: number): string {
  let s = start;
  let e = Math.max(end, start);
  while (s > 0 && WORD.test(text[s - 1]!)) s--;
  while (e < text.length && WORD.test(text[e]!)) e++;
  return text.slice(s, e);
}

/** Dates, times, ISO timestamps, UUIDs, long hex ids, epoch seconds or milliseconds. */
const CLOCK_OR_ID =
  /\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}(:\d{2})?\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|^[0-9a-f]{16,}$|^\d{10,13}$/i;

/**
 * Whether two versions of a text differ only in a value that changes on every run by
 * itself — a timestamp, a date, a request id — rather than an edit someone made.
 * "at most 5 results" → "at most 10 results" is an edit; a different ISO time is not.
 */
export function volatileChange(a: string, b: string): boolean {
  const span = changedSpan(a, b);
  if (!span) return false;
  const was = tokenAround(a, span.at, span.at + span.was.length);
  const now = tokenAround(b, span.at, span.at + span.now.length);
  return CLOCK_OR_ID.test(was) && CLOCK_OR_ID.test(now);
}

export interface TextChange {
  /** Character offset of the first difference. */
  at: number;
  was: string;
  now: string;
  /** The change is a timestamp or id: it will differ on every run. */
  volatile: boolean;
  /** The change is inside a redacted secret: `was` and `now` are its placeholder. */
  redacted?: true;
}

export interface ToolChange {
  name: string;
  base?: number;
  head?: number;
  /** The definition changed but its token count did not. */
  textChanged?: boolean;
}

export interface CacheBreak {
  /** The request where the reusable prefix broke, and the earlier request it continues. */
  turn: number;
  previous: number;
  /** "the system prompt", "the definition of search", "a user message", … */
  where: string;
  /** Identifies the location across runs: `where`, plus the position for a conversation section. */
  key: string;
  /** In the system prompt or tool definitions — your code — rather than the conversation. */
  inPrefix: boolean;
  at: number;
  /**
   * The changed characters. Only for the system prompt and tool definitions: text from
   * the conversation (what a user typed, what a tool returned) is never quoted.
   */
  was?: string;
  now?: string;
  /** The change is a timestamp or id rendered in on every request. */
  volatile: boolean;
  /** The change is inside a redacted secret; `was` and `now`, when set, are its placeholder. */
  redacted?: true;
  /** Tokens from the break onward that the earlier request had and this one re-sends uncached. */
  tokens: number;
}

export interface Side {
  turns: number;
  inputTokens: number;
  /** Every count came from provider usage. */
  exact: boolean;
  offline: boolean;
  system: number;
  tools: number;
  toolCount: number;
  /** First request's conversation: everything after the system prompt and tool definitions. */
  conversation: number;
  /** Every place a request stops repeating the request it continues, one per location. */
  cacheBreaks: CacheBreak[];
}

export interface DiffOptions {
  /** Fail when input tokens per run grow by more than this many percent. */
  maxIncreasePct?: number;
  /** Fail when input tokens per run grow by more than this many tokens. */
  maxIncreaseTokens?: number;
  /** USD per million input tokens, for the cost line. */
  pricePerMTok?: number;
  /** How many times a day this scenario runs in production, for the cost line. */
  runsPerDay?: number;
}

export interface Diff {
  base: Side;
  head: Side;
  delta: { tokens: number; pct: number | null };
  system: { base: number; head: number; change: TextChange | null };
  tools: { added: ToolChange[]; removed: ToolChange[]; changed: ToolChange[] };
  turns: { n: number; base?: number; head?: number }[];
  cache: {
    /** Breaks in this change at a place where the baseline had none. */
    introduced: CacheBreak[];
    /** Breaks in the baseline that this change no longer has. */
    fixed: CacheBreak[];
    /** The prefix differs between baseline and this change at a value that changes every run. */
    volatile: TextChange | null;
  };
  cost: { perRunUsd: number; perDayUsd?: number; pricePerMTok: number; runsPerDay?: number } | null;
  /** Things that make the numbers less trustworthy than they look. */
  warnings: string[];
  /** Why the check fails. Empty when it passes. */
  failures: string[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isPrefixKind = (s: SnapshotSection) => s.kind === "system" || s.kind === "tool-def";

/** Index of the first conversation section: everything before it is the static prefix. */
/**
 * Two sections whose redacted text is identical but whose hashes differ: the change is
 * inside a redacted secret. `marker` is that secret's placeholder when it is known
 * which one changed: there is only one, or both sides carry fingerprints (a session,
 * not a committed snapshot). Otherwise it says how many it could be, and `at` is the
 * first of them.
 */
function insideSecret(
  was: SnapshotSection,
  now: SnapshotSection,
): { at: number; marker: string } | null {
  if (was.text === undefined || was.text !== now.text || was.hash === now.hash) return null;
  const markers = [...was.text.matchAll(REDACTED)];
  if (!markers.length) return null;
  let k = markers.length === 1 ? 0 : -1;
  if (was.secrets && now.secrets && was.secrets.length === now.secrets.length)
    k = was.secrets.findIndex((h, i) => h !== now.secrets![i]);
  const m = markers[k] ?? markers[0]!;
  return {
    at: m.index,
    marker: markers[k] ? m[0] : `one of the ${markers.length} redacted secrets`,
  };
}

export function prefixLength(sections: SnapshotSection[]): number {
  const i = sections.findIndex((s) => !isPrefixKind(s));
  return i === -1 ? sections.length : i;
}

const prefixOf = (t: SnapshotTurn | undefined) =>
  (t?.sections ?? []).slice(0, prefixLength(t?.sections ?? []));

function describeSection(s: SnapshotSection, inPrefix: boolean): string {
  if (inPrefix && s.kind === "system") return "the system prompt";
  if (s.kind === "tool-def") return `the definition of ${s.name ?? "a tool"}`;
  if (s.kind === "tool-result") return `a ${s.name ? `${s.name} ` : ""}tool result`;
  if (s.kind === "system") return "a system message in the conversation";
  return `a ${s.kind} message`;
}

const same = (a: SnapshotSection | undefined, b: SnapshotSection | undefined) =>
  !!a && !!b && a.hash !== undefined && a.hash === b.hash;

/**
 * Whether `later` carries on the conversation of `earlier`: the same API and model, the
 * earlier conversation repeated (allowing a section or so to have changed — that change
 * is what we are looking for), and the earlier request's reply right after it.
 *
 * That last condition is what separates a continuation from requests that merely look
 * alike: a sub-agent, a parallel conversation, the next question after shared few-shot
 * examples, a Responses API call that sends only new items. None of those contains the
 * earlier request's answer, so none of them is expected to repeat its prefix.
 */
function continues(earlier: SnapshotTurn, later: SnapshotTurn): boolean {
  if (earlier.kind !== later.kind || earlier.model !== later.model) return false;
  const ep = prefixLength(earlier.sections);
  const lp = prefixLength(later.sections);
  const ec = earlier.sections.slice(ep);
  const lc = later.sections.slice(lp);
  if (!ec.length || lc.length <= ec.length) return false;
  if (lc[ec.length]!.kind !== "assistant") return false;
  for (let j = 0; j < ec.length; j++) if (ec[j]!.kind !== lc[j]!.kind) return false;
  if (ec.some((s) => s.hash === undefined) || lc.some((s) => s.hash === undefined)) return false;
  // The message the earlier request was answering must come back unchanged (give or
  // take a timestamp): a request whose last shared message differs asked something
  // else — the next question after shared few-shot examples — and is not a continuation.
  const last = ec.length - 1;
  const lastEarlier = ec[last]!;
  const lastLater = lc[last]!;
  if (
    !same(lastEarlier, lastLater) &&
    !(
      lastEarlier.text !== undefined &&
      lastLater.text !== undefined &&
      volatileChange(lastEarlier.text, lastLater.text)
    )
  )
    return false;
  const matching = ec.filter((s, j) => same(s, lc[j])).length;
  if (matching >= Math.max(1, Math.ceil(ec.length / 2))) return true;
  // A short conversation whose differences are all timestamps or ids is still the same one.
  return ec.every(
    (s, j) =>
      same(s, lc[j]) ||
      (s.text !== undefined && lc[j]!.text !== undefined && volatileChange(s.text, lc[j]!.text!)),
  );
}

/**
 * Every place where a request stops repeating the earlier request it continues. Prompt
 * caches key on an exact prefix: what a conversation sent before must reappear
 * unchanged, with only new messages after. The first section that differs is where
 * caching stops working for everything after it.
 */
export function findCacheBreaks(snapshot: Snapshot): CacheBreak[] {
  const turns = snapshot.turns;
  const breaks = new Map<string, CacheBreak>();
  for (let i = 1; i < turns.length; i++) {
    const cur = turns[i]!;
    let prev: SnapshotTurn | undefined;
    for (let k = i - 1; k >= 0 && !prev; k--) if (continues(turns[k]!, cur)) prev = turns[k];
    if (!prev) continue;
    const ep = prefixLength(prev.sections);
    const lp = prefixLength(cur.sections);
    // Compare the static prefixes, then the repeated conversation.
    const pairs: [SnapshotSection | undefined, SnapshotSection | undefined, boolean][] = [];
    for (let j = 0; j < Math.max(ep, lp); j++)
      pairs.push([prev.sections[j], cur.sections[j], true]);
    for (let j = 0; j < prev.sections.length - ep; j++)
      pairs.push([prev.sections[ep + j], cur.sections[lp + j], false]);
    let tokensBefore = 0;
    for (let p = 0; p < pairs.length; p++) {
      const [was, now, inPrefix] = pairs[p]!;
      if (same(was, now)) {
        tokensBefore += was!.tokens;
        continue;
      }
      const section = now ?? was!;
      const where = describeSection(section, inPrefix);
      const texts = was?.text !== undefined && now?.text !== undefined;
      const span = texts ? changedSpan(was!.text!, now!.text!) : null;
      const secret = texts && !span ? insideSecret(was!, now!) : null;
      const brk: CacheBreak = {
        turn: cur.n,
        previous: prev.n,
        where,
        key: inPrefix ? where : `${where} #${p - Math.max(ep, lp) + 1}`,
        inPrefix,
        at: span?.at ?? secret?.at ?? 0,
        ...(span && inPrefix ? { was: span.was, now: span.now } : {}),
        ...(secret
          ? {
              redacted: true as const,
              ...(inPrefix ? { was: secret.marker, now: secret.marker } : {}),
            }
          : {}),
        volatile: texts ? volatileChange(was!.text!, now!.text!) : false,
        tokens: sum(prev.sections.map((s) => s.tokens)) - tokensBefore,
      };
      if (!breaks.has(brk.key)) breaks.set(brk.key, brk);
      break;
    }
  }
  return [...breaks.values()];
}

/** The first break, if any. */
export function findCacheBreak(snapshot: Snapshot): CacheBreak | null {
  return findCacheBreaks(snapshot)[0] ?? null;
}

function side(snapshot: Snapshot): Side {
  const first = snapshot.turns[0];
  const prefix = prefixOf(first);
  const system = sum(prefix.filter((s) => s.kind === "system").map((s) => s.tokens));
  const tools = sum(prefix.filter((s) => s.kind === "tool-def").map((s) => s.tokens));
  return {
    turns: snapshot.turns.length,
    inputTokens: sum(snapshot.turns.map((t) => t.totalTokens)),
    exact: snapshot.turns.length > 0 && snapshot.turns.every((t) => t.exact),
    offline: snapshot.offline,
    system,
    tools,
    toolCount: prefix.filter((s) => s.kind === "tool-def").length,
    conversation: (first?.totalTokens ?? 0) - system - tools,
    // A committed snapshot carries its breaks (it keeps no conversation hashes to find
    // them again); a session or in-memory snapshot is analysed here.
    cacheBreaks: snapshot.cacheBreaks ?? findCacheBreaks(snapshot),
  };
}

const textOf = (sections: SnapshotSection[]) =>
  sections.every((s) => s.text !== undefined) ? sections.map((s) => s.text).join("\n") : undefined;

/** Tool definitions keyed by name, with a suffix for a repeated name so none is lost. */
function toolDefs(t: SnapshotTurn | undefined): Map<string, SnapshotSection> {
  const out = new Map<string, SnapshotSection>();
  const seen = new Map<string, number>();
  for (const s of prefixOf(t).filter((x) => x.kind === "tool-def")) {
    const name = s.name ?? "";
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.set(n === 1 ? name : `${name} (#${n})`, s);
  }
  return out;
}

export function diffSnapshots(base: Snapshot, head: Snapshot, options: DiffOptions = {}): Diff {
  const b = side(base);
  const h = side(head);
  const tokens = h.inputTokens - b.inputTokens;
  const pct = b.inputTokens > 0 ? (tokens / b.inputTokens) * 100 : null;

  // System prompt: quote the first change.
  const bText = textOf(prefixOf(base.turns[0]).filter((s) => s.kind === "system"));
  const hText = textOf(prefixOf(head.turns[0]).filter((s) => s.kind === "system"));
  const span = bText !== undefined && hText !== undefined ? changedSpan(bText, hText) : null;
  let systemChange: TextChange | null = span
    ? { ...span, volatile: volatileChange(bText!, hText!) }
    : null;
  if (!span && bText !== undefined && bText === hText) {
    // Same redacted text, different hashes: the change is inside a secret.
    const bSys = prefixOf(base.turns[0]).filter((s) => s.kind === "system");
    const hSys = prefixOf(head.turns[0]).filter((s) => s.kind === "system");
    let offset = 0;
    for (let i = 0; i < Math.min(bSys.length, hSys.length); i++) {
      const secret = insideSecret(bSys[i]!, hSys[i]!);
      if (secret) {
        const at = offset + secret.at;
        systemChange = {
          at,
          was: secret.marker,
          now: secret.marker,
          volatile: false,
          redacted: true,
        };
        break;
      }
      offset += (bSys[i]!.text?.length ?? 0) + 1;
    }
  }

  const bTools = toolDefs(base.turns[0]);
  const hTools = toolDefs(head.turns[0]);
  const added: ToolChange[] = [];
  const removed: ToolChange[] = [];
  const changed: ToolChange[] = [];
  for (const [name, s] of hTools) {
    const was = bTools.get(name);
    if (!was) added.push({ name, head: s.tokens });
    else if (was.hash !== s.hash)
      changed.push({
        name,
        base: was.tokens,
        head: s.tokens,
        ...(was.tokens === s.tokens ? { textChanged: true } : {}),
      });
  }
  for (const [name, s] of bTools) if (!hTools.has(name)) removed.push({ name, base: s.tokens });
  const byTokens = (a: ToolChange, z: ToolChange) =>
    Math.abs((z.head ?? 0) - (z.base ?? 0)) - Math.abs((a.head ?? 0) - (a.base ?? 0));
  added.sort(byTokens);
  removed.sort(byTokens);
  changed.sort(byTokens);

  const n = Math.max(base.turns.length, head.turns.length);
  const turns = Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    ...(base.turns[i] ? { base: base.turns[i]!.totalTokens } : {}),
    ...(head.turns[i] ? { head: head.turns[i]!.totalTokens } : {}),
  }));

  const cost =
    options.pricePerMTok !== undefined
      ? {
          pricePerMTok: options.pricePerMTok,
          perRunUsd: (tokens / 1_000_000) * options.pricePerMTok,
          ...(options.runsPerDay !== undefined
            ? {
                runsPerDay: options.runsPerDay,
                perDayUsd: (tokens / 1_000_000) * options.pricePerMTok * options.runsPerDay,
              }
            : {}),
        }
      : null;

  const baseKeys = new Set(b.cacheBreaks.map((x) => x.key));
  const headKeys = new Set(h.cacheBreaks.map((x) => x.key));
  const introduced = h.cacheBreaks.filter((x) => !baseKeys.has(x.key));
  const fixed = b.cacheBreaks.filter((x) => !headKeys.has(x.key));

  const warnings: string[] = [];
  if (b.turns && h.turns && b.exact !== h.exact)
    warnings.push(
      `the baseline was counted ${b.exact ? "by the provider" : "with a tokenizer estimate"} and this run ${h.exact ? "by the provider" : "with a tokenizer estimate"}; part of the difference is the counting method — re-record both the same way`,
    );
  if (base.turns[0]?.model !== head.turns[0]?.model)
    warnings.push(
      `the model changed (${base.turns[0]?.model ?? "?"} → ${head.turns[0]?.model ?? "?"}); token counts are not comparable across tokenizers`,
    );

  for (const [label, s] of [
    ["the baseline", base],
    ["this run", head],
  ] as const)
    for (const m of s.incomplete ?? []) warnings.push(`${label} is missing a request: ${m}`);

  const failures: string[] = [];
  for (const x of introduced) failures.push(`this change breaks prompt caching at ${x.where}`);
  if (options.maxIncreasePct !== undefined && pct !== null && pct > options.maxIncreasePct)
    failures.push(
      `input tokens per run grew ${pct.toFixed(1)}%, over the ${options.maxIncreasePct}% limit`,
    );
  if (options.maxIncreaseTokens !== undefined && tokens > options.maxIncreaseTokens)
    failures.push(
      `input tokens per run grew by ${tokens.toLocaleString("en-US")}, over the ${options.maxIncreaseTokens.toLocaleString("en-US")} limit`,
    );

  return {
    base: b,
    head: h,
    delta: { tokens, pct },
    system: { base: b.system, head: h.system, change: systemChange },
    tools: { added, removed, changed },
    turns,
    cache: { introduced, fixed, volatile: systemChange?.volatile ? systemChange : null },
    cost,
    warnings,
    failures,
  };
}
