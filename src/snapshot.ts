import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SectionKind } from "./context.js";
import { findCacheBreaks, prefixLength, type CacheBreak } from "./diff.js";
import { turnsOf } from "./lint.js";
import type { Turn } from "./rules/index.js";
import { readSession } from "./session.js";
import type { ApiKind } from "./types.js";
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
   * mid-conversation) is never written.
   */
  text?: string;
  cacheControl?: true;
}

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
      sections: t.context.sections.map((s) => ({
        kind: s.kind,
        ...(s.name !== undefined ? { name: s.name } : {}),
        tokens: s.tokens,
        hash: s.hash,
        text: s.text,
        ...(s.cacheControl ? { cacheControl: true as const } : {}),
      })),
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
          if (i < prefix) return s;
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
      return parsed as Snapshot;
    }
  }
  return toSnapshot(turnsOf(readSession(path)), keepText);
}

export function writeSnapshot(path: string, snapshot: Snapshot): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
}
