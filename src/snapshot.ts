import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SectionKind } from "./context.js";
import { findCacheBreaks, prefixLength, type CacheBreak } from "./diff.js";
import { incompleteOf, turnsOf } from "./lint.js";
import { createHash } from "node:crypto";
import { redact, redactSecrets } from "./rules/patterns.js";
import type { Turn } from "./rules/index.js";
import { readSession } from "./session.js";
import type { ApiKind, Exchange } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_SNAPSHOT = "tokenwire.snapshot.json";
export const SNAPSHOT_FORMAT = 1;

export interface SnapshotSection {
  kind: SectionKind;
  name?: string;
  tokens: number;
  /**
   * SHA-256 of the section text. In a committed snapshot, only for the static prefix
   * (system prompt and tool definitions): a hash of a short user message can be
   * reversed by guessing, so conversation sections carry none.
   */
  hash?: string;
  /**
   * The text. In a committed snapshot, only for the static prefix — the system prompt
   * and tool definitions at the start of the request, which live in your code.
   * Conversation text (what users typed, what tools returned, system messages inserted
   * mid-conversation) is never written. Anything `secret-in-context` would flag is
   * replaced with `[redacted: …]`; `tokens` and `hash` are of the text as sent.
   */
  text?: string;
  cacheControl?: true;
  /**
   * SHA-256 of each secret redacted from `text`, in order. In memory only, never
   * written: it lets a diff say which placeholder a change is inside.
   */
  secrets?: string[];
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

export interface SnapshotTurn {
  n: number;
  kind: ApiKind;
  model?: string;
  totalTokens: number;
  /** The total came from the provider's usage, not the tokenizer. */
  exact: boolean;
  sections: SnapshotSection[];
}

/** What a scenario sends the model, in a form small and stable enough to commit. */
export interface Snapshot {
  tokenwire: typeof SNAPSHOT_FORMAT;
  version: string;
  /** Captured with --offline (no provider usage; every count is an estimate). */
  offline: boolean;
  turns: SnapshotTurn[];
  /**
   * Cache breaks within the run, found when the snapshot was taken — a committed
   * snapshot keeps no conversation hashes to find them again.
   */
  cacheBreaks?: CacheBreak[];
  /** Requests the record could not keep whole, so they are missing from `turns`. */
  incomplete?: string[];
}

/**
 * `keepText: "prefix"` is the committable form: text and hashes for the static prefix
 * only, cache breaks precomputed. `"all"` keeps everything, in memory, for the side
 * being diffed.
 */
export function toSnapshot(turns: Turn[], keepText: "prefix" | "all" = "prefix"): Snapshot {
  const full: Snapshot = {
    tokenwire: SNAPSHOT_FORMAT,
    version: VERSION,
    offline: turns.length > 0 && turns.every((t) => t.exchange.offline),
    turns: turns.map((t) => ({
      n: t.n,
      kind: t.context.kind,
      ...(t.context.model ? { model: t.context.model } : {}),
      totalTokens: t.context.totalTokens,
      exact: t.context.exact,
      sections: t.context.sections.map((s) => {
        // Redacted on both sides of a diff alike, so a secret is never quoted and the
        // redaction itself never reads as a change.
        const r = redact(s.text);
        return {
          kind: s.kind,
          ...(s.name !== undefined ? { name: s.name } : {}),
          tokens: s.tokens,
          hash: s.hash,
          text: r.text,
          ...(s.cacheControl ? { cacheControl: true as const } : {}),
          ...(r.secrets.length ? { secrets: r.secrets.map(sha256) } : {}),
        };
      }),
    })),
  };
  if (keepText === "all") return full;
  return {
    ...full,
    cacheBreaks: findCacheBreaks(full),
    turns: full.turns.map((t) => {
      const prefix = prefixLength(t.sections);
      return {
        ...t,
        sections: t.sections.map((s, i) => {
          if (i < prefix) {
            const kept = { ...s };
            delete kept.secrets;
            return kept;
          }
          // Conversation sections: kind, name and size only.
          return {
            kind: s.kind,
            ...(s.name !== undefined ? { name: s.name } : {}),
            tokens: s.tokens,
            ...(s.cacheControl ? { cacheControl: true as const } : {}),
          };
        }),
      };
    }),
  };
}

function snapshotError(path: string, raw: string): Error | undefined {
  if (/^(<{7}|={7}|>{7})( |$)/m.test(raw))
    return new Error(
      `${path} has unresolved merge-conflict markers. Re-record it: tokenwire snapshot`,
    );
  return undefined;
}

/**
 * Reads either a committed snapshot (`tokenwire.snapshot.json`) or a recorded session
 * (`*.jsonl`) — whichever the path holds — as a snapshot.
 */
export function loadSnapshot(path: string, keepText: "prefix" | "all" = "prefix"): Snapshot {
  if (!existsSync(path)) throw new Error(`no snapshot or session at ${path}`);
  const raw = readFileSync(path, "utf8");
  const conflict = snapshotError(path, raw);
  if (conflict) throw conflict;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const format = (parsed as { tokenwire?: unknown } | undefined)?.tokenwire;
    if (format !== undefined) {
      if (format !== SNAPSHOT_FORMAT || !Array.isArray((parsed as { turns?: unknown }).turns))
        throw new Error(
          `${path} is snapshot format ${JSON.stringify(format)}; this tokenwire (${VERSION}) reads format ${SNAPSHOT_FORMAT}. Upgrade tokenwire, or re-record the snapshot.`,
        );
      return redactLoaded(parsed as Snapshot);
    }
  }
  return fromSession(readSession(path), keepText);
}

/**
 * A committed snapshot may predate redaction: redact its text as it is read. If any
 * text held a secret, its cache-break quotes may hold a piece of one too, too short
 * for a pattern to recognise, so they are dropped; the location is kept.
 */
function redactLoaded(snapshot: Snapshot): Snapshot {
  let found = false;
  const turns = snapshot.turns.map((t) => ({
    ...t,
    sections: t.sections.map((s) => {
      if (s.text === undefined) return s;
      const text = redactSecrets(s.text);
      if (text !== s.text) found = true;
      return { ...s, text };
    }),
  }));
  const cacheBreaks = snapshot.cacheBreaks?.map((b) => {
    if (found) {
      const rest = { ...b };
      delete rest.was;
      delete rest.now;
      return rest;
    }
    return {
      ...b,
      ...(b.was !== undefined ? { was: redactSecrets(b.was) } : {}),
      ...(b.now !== undefined ? { now: redactSecrets(b.now) } : {}),
    };
  });
  return { ...snapshot, turns, ...(cacheBreaks ? { cacheBreaks } : {}) };
}

/** A snapshot of a recorded session, noting any request too large to record whole. */
export function fromSession(
  exchanges: Exchange[],
  keepText: "prefix" | "all" = "prefix",
): Snapshot {
  const snapshot = toSnapshot(turnsOf(exchanges), keepText);
  const incomplete = exchanges.flatMap((x, i) => incompleteOf(x, i + 1));
  return incomplete.length ? { ...snapshot, incomplete } : snapshot;
}

export function writeSnapshot(path: string, snapshot: Snapshot): void {
  // `secrets` fingerprints are for in-memory comparison only.
  const replacer = (key: string, value: unknown) => (key === "secrets" ? undefined : value);
  writeFileSync(path, JSON.stringify(snapshot, replacer, 2) + "\n");
}
