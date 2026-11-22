import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedSpan, diffSnapshots, findCacheBreaks, volatileChange } from "../src/diff.js";
import { lintExchanges, turnsOf } from "../src/lint.js";
import { COMMENT_MARKER, renderDiffMarkdown, renderDiffText } from "../src/render-diff.js";
import { appendExchange } from "../src/session.js";
import { loadSnapshot, toSnapshot, writeSnapshot } from "../src/snapshot.js";
import type { Exchange } from "../src/types.js";
import { anthropicExchange, prose } from "./helpers/session.js";
import type { AnthropicTurn } from "./helpers/session.js";

const tmp = mkdtempSync(join(tmpdir(), "tokenwire-diff-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SYSTEM = `You are the billing assistant. ${prose(120, "sys")}`;
const TOOLS = [{ name: "get_invoice" }, { name: "open_ticket" }];
type Msg = AnthropicTurn["messages"][number];
const user = (content: unknown): Msg => ({ role: "user", content });
const call = (id: string): Msg => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "get_invoice", input: { n: id } }],
});
const result = (id: string, text: string): Msg =>
  user([{ type: "tool_result", tool_use_id: id, content: text }]);

/** A two-request agent loop: the second request repeats the first and appends a tool round trip. */
function loop(
  over: {
    system?: string;
    system2?: string;
    tools?: AnthropicTurn["tools"];
    model?: string;
    q?: string;
  } = {},
): Exchange[] {
  const q = user(over.q ?? "Why was I charged twice?");
  const base = { tools: over.tools ?? TOOLS, ...(over.model ? { model: over.model } : {}) };
  return [
    anthropicExchange({ ...base, system: over.system ?? SYSTEM, messages: [q] }, 0),
    anthropicExchange(
      {
        ...base,
        system: over.system2 ?? over.system ?? SYSTEM,
        messages: [q, call("t1"), result("t1", "INV-1: refunded")],
      },
      1,
    ),
  ];
}
const renumber = (xs: Exchange[]) => xs.map((x, i) => ({ ...x, id: `x${i}` }));
const snap = (x: Exchange[], keep: "prefix" | "all" = "all") =>
  toSnapshot(turnsOf(renumber(x)), keep);
const breaks = (x: Exchange[]) => findCacheBreaks(snap(x));

function openaiChat(messages: { role: string; content: string }[]): Exchange {
  const x = anthropicExchange({ messages: [] }, 0);
  return {
    ...x,
    path: "/v1/chat/completions",
    kind: "openai-chat",
    model: "gpt-5",
    request: { headers: {}, body: { model: "gpt-5", messages }, bytes: 0 },
  };
}

describe("volatileChange", () => {
  it("is a timestamp, a date or an id — not an edit", () => {
    expect(volatileChange("Now: 2026-11-22T04:14:39.785Z.", "Now: 2026-11-22T04:14:41.328Z.")).toBe(
      true,
    );
    expect(volatileChange("Today is 2026-11-21.", "Today is 2026-11-22.")).toBe(true);
    expect(
      volatileChange("req 3f2a9c1e-77aa-4b1c-9d2e-1f0a", "req 9b7e2d10-11aa-4b1c-9d2e-1f0a"),
    ).toBe(true);
    expect(volatileChange("return at most 5 results", "return at most 10 results")).toBe(false);
    expect(volatileChange("refunds within 30 days", "refunds within 14 days")).toBe(false);
    expect(volatileChange("same", "same")).toBe(false);
  });
  it("changedSpan isolates the part that differs", () => {
    expect(changedSpan("time: 10:00:01 ok", "time: 10:00:02 ok")).toEqual({
      at: 13,
      was: "1",
      now: "2",
    });
  });
});

describe("findCacheBreaks: real breaks", () => {
  it("none when each request repeats the one it continues", () => {
    expect(breaks(loop())).toEqual([]);
  });

  it("a system prompt re-rendered per request, quoted, and called a timestamp", () => {
    const [b] = breaks(
      loop({
        system: `${SYSTEM} Now: 2026-11-22T04:14:39Z.`,
        system2: `${SYSTEM} Now: 2026-11-22T04:14:41Z.`,
      }),
    );
    expect(b).toMatchObject({
      turn: 2,
      previous: 1,
      where: "the system prompt",
      inPrefix: true,
      volatile: true,
      was: "39",
      now: "41",
    });
  });

  it("tools reordered between requests", () => {
    const x = loop();
    const body = x[1]!.request.body as { tools: unknown[] };
    body.tools.reverse();
    expect(breaks(x)[0]!.where).toBe("the definition of open_ticket");
  });

  it("history rewritten in a longer conversation — located, never quoted", () => {
    const q = user("Why was I charged twice?");
    const first = [
      q,
      call("t1"),
      result("t1", "INV-1: refunded"),
      { role: "assistant" as const, content: "Refunded." },
      user("thanks"),
    ];
    const edited = [...first];
    edited[2] = result("t1", "INV-1: refunded [secret note]");
    const xs = [
      anthropicExchange({ system: SYSTEM, tools: TOOLS, messages: first }, 0),
      anthropicExchange(
        {
          system: SYSTEM,
          tools: TOOLS,
          messages: [...edited, { role: "assistant", content: "ok" }, user("bye")],
        },
        1,
      ),
    ];
    const [b] = breaks(xs);
    expect(b).toMatchObject({ where: "a get_invoice tool result", inPrefix: false });
    expect(b!.was).toBeUndefined();
    const md = renderDiffMarkdown(diffSnapshots(snap(loop(), "prefix"), snap(xs)));
    expect(md).not.toContain("secret note");
  });

  it("is found across another model's request in between — the way Claude Code interleaves", () => {
    const [a1, a2] = loop({
      system: `${SYSTEM} t=2026-11-22T04:14:39Z`,
      system2: `${SYSTEM} t=2026-11-22T04:14:41Z`,
    });
    const haiku = anthropicExchange(
      { model: "claude-haiku-5", system: "classify", messages: [user("x")] },
      1,
    );
    expect(breaks([a1!, haiku, a2!])).toHaveLength(1);
  });
});

describe("findCacheBreaks: not breaks", () => {
  it("a sub-agent with its own system prompt", () => {
    const [a1, a2] = loop();
    const sub = anthropicExchange(
      { system: "You are a search sub-agent.", messages: [user("find INV-1")] },
      1,
    );
    expect(breaks([a1!, sub, a2!])).toEqual([]);
  });

  it("interleaved parallel conversations", () => {
    const [a1, a2] = loop({ q: "conversation A" });
    const [b1] = loop({ q: "conversation B" });
    expect(breaks([a1!, b1!, a2!])).toEqual([]);
  });

  it("independent questions after shared few-shot examples", () => {
    const shots: Msg[] = [user("example q"), { role: "assistant", content: "example a" }];
    expect(
      breaks([
        anthropicExchange({ system: SYSTEM, messages: [...shots, user("q1")] }, 0),
        anthropicExchange(
          {
            system: SYSTEM,
            messages: [...shots, user("q2"), { role: "assistant", content: "x" }, user("more")],
          },
          1,
        ),
      ]),
    ).toEqual([]);
  });

  it("a Responses API follow-up that sends only new items", () => {
    const r = (input: unknown[]): Exchange => ({
      ...anthropicExchange({ messages: [] }, 0),
      path: "/v1/responses",
      kind: "openai-responses",
      model: "gpt-5",
      request: { headers: {}, body: { model: "gpt-5", instructions: "be brief", input }, bytes: 0 },
    });
    expect(
      breaks([
        r([{ type: "function_call_output", call_id: "a", output: "1" }]),
        r([
          { type: "function_call_output", call_id: "b", output: "2" },
          { type: "function_call_output", call_id: "c", output: "3" },
        ]),
      ]),
    ).toEqual([]);
  });

  it("a fresh conversation with the same system prompt", () => {
    const [a1] = loop({ q: "first question" });
    const fresh = anthropicExchange(
      { system: SYSTEM, tools: TOOLS, messages: [user("new chat")] },
      1,
    );
    expect(breaks([a1!, fresh])).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  it("reports nothing for identical runs", () => {
    const d = diffSnapshots(snap(loop(), "prefix"), snap(loop()));
    expect(d.delta.tokens).toBe(0);
    expect(d.tools).toEqual({ added: [], removed: [], changed: [] });
    expect(d.failures).toEqual([]);
    expect(renderDiffMarkdown(d)).toContain("✅ No change to what is sent.");
  });

  it("itemises tools added, removed and changed, biggest first", () => {
    const head = loop({
      tools: [
        { name: "get_invoice", description: prose(60, "longer") },
        { name: "search_kb", description: prose(200, "kb") },
        { name: "tiny" },
      ],
    });
    const d = diffSnapshots(snap(loop(), "prefix"), snap(head));
    expect(d.tools.added.map((t) => t.name)).toEqual(["search_kb", "tiny"]);
    expect(d.tools.removed.map((t) => t.name)).toEqual(["open_ticket"]);
    expect(d.tools.changed.map((t) => t.name)).toEqual(["get_invoice"]);
  });

  it("keeps duplicate tool names apart", () => {
    const base = loop({ tools: [{ name: "s" }, { name: "s" }] });
    const head = loop({ tools: [{ name: "s", description: prose(150, "grown") }, { name: "s" }] });
    const d = diffSnapshots(snap(base, "prefix"), snap(head));
    expect(d.tools.changed.map((t) => t.name)).toEqual(["s"]);
    expect(
      diffSnapshots(snap(base, "prefix"), snap(loop({ tools: [{ name: "s" }] }))).tools.removed.map(
        (t) => t.name,
      ),
    ).toEqual(["s (#2)"]);
  });

  it("a reworded tool is a change, not 'no change'", () => {
    const head = loop({
      tools: [
        { name: "get_invoice", description: "get_invoice does something useful for the userz." },
        { name: "open_ticket" },
      ],
    });
    const md = renderDiffMarkdown(diffSnapshots(snap(loop(), "prefix"), snap(head)));
    expect(md).not.toContain("No change to what is sent");
  });

  it("quotes a deliberate edit, including a number, without calling it volatile", () => {
    const d = diffSnapshots(
      snap(loop({ system: `${SYSTEM} Return at most 5 results.` }), "prefix"),
      snap(loop({ system: `${SYSTEM} Return at most 10 results.` })),
    );
    expect(d.system.change).toMatchObject({ was: "5", now: "10", volatile: false });
    expect(d.cache.volatile).toBeNull();
    expect(renderDiffMarkdown(d)).toContain("**System prompt** changed at char");
  });

  it("calls out a date in the prefix that differs between runs", () => {
    const d = diffSnapshots(
      snap(loop({ system: `Today is 2026-11-21. ${SYSTEM}` }), "prefix"),
      snap(loop({ system: `Today is 2026-11-22. ${SYSTEM}` })),
    );
    expect(d.cache.volatile).toMatchObject({ volatile: true });
    expect(renderDiffMarkdown(d)).toContain("a value that changes every run");
  });

  it("fails on a new break even when the baseline already had a different one", () => {
    const tsSystem = {
      system: `${SYSTEM} t=2026-11-22T04:14:39Z`,
      system2: `${SYSTEM} t=2026-11-22T04:14:41Z`,
    };
    const reorder = (x: Exchange[]) => {
      (x[1]!.request.body as { tools: unknown[] }).tools.reverse();
      return x;
    };
    const baseBroken = reorder(loop());
    const both = reorder(loop(tsSystem));
    const d = diffSnapshots(snap(baseBroken, "prefix"), snap(both));
    expect(d.cache.introduced.map((b) => b.where)).toEqual(["the system prompt"]);
    expect(d.failures).toEqual(["this change breaks prompt caching at the system prompt"]);
    const md = renderDiffMarkdown(d);
    expect(md).toContain("❌");
    const already = diffSnapshots(snap(baseBroken, "prefix"), snap(reorder(loop())));
    expect(already.failures).toEqual([]);
    expect(renderDiffMarkdown(already)).toContain("already broken before this change");
    expect(diffSnapshots(snap(baseBroken, "prefix"), snap(loop())).cache.fixed).toHaveLength(1);
  });

  it("enforces --max-increase as a percentage or a token count", () => {
    const head = loop({ system: `${SYSTEM} ${prose(300, "more")}` });
    const d = (o: object) => diffSnapshots(snap(loop(), "prefix"), snap(head), o);
    expect(d({ maxIncreasePct: 10 }).failures[0]).toMatch(/grew \d+\.\d%, over the 10% limit/);
    expect(d({ maxIncreasePct: 1000 }).failures).toEqual([]);
    expect(d({ maxIncreaseTokens: 100 }).failures[0]).toMatch(/over the 100 limit/);
  });

  it("prices the change", () => {
    const head = loop({ system: `${SYSTEM} ${prose(300, "more")}` });
    const d = diffSnapshots(snap(loop(), "prefix"), snap(head), {
      pricePerMTok: 3,
      runsPerDay: 10_000,
    });
    expect(d.cost!.perRunUsd).toBeCloseTo((d.delta.tokens / 1e6) * 3, 10);
    expect(d.cost!.perDayUsd).toBeCloseTo(d.cost!.perRunUsd * 10_000, 6);
    expect(renderDiffText(d)).toContain("/day at 10,000 runs/day");
    // Estimated counts: every dollar figure says so.
    expect(renderDiffText(d)).toContain("estimated: o200k token counts");
    expect(renderDiffMarkdown(d)).toMatch(/\*\*Cost\*\*.*estimated: o200k token counts/);
  });

  it("warns when one side was counted by the provider and the other estimated", () => {
    const exact = loop().map((x) => ({
      ...x,
      response: {
        ...x.response,
        usage: { ...x.response.usage, source: "provider" as const, input: 900 },
      },
    }));
    const d = diffSnapshots(snap(exact, "prefix"), snap(loop()));
    expect(d.warnings[0]).toMatch(/counting method/);
    expect(renderDiffMarkdown(d)).toContain("> ⚠️");
  });
});

describe("snapshots keep no conversation content", () => {
  it("no user or tool text, and no conversation hashes", () => {
    const s = snap(loop(), "prefix");
    const json = JSON.stringify(s);
    expect(json).toContain("You are the billing assistant");
    expect(json).not.toContain("charged twice");
    expect(json).not.toContain("INV-1: refunded");
    const conv = s.turns[1]!.sections.filter((x) => x.kind !== "system" && x.kind !== "tool-def");
    expect(conv.every((x) => x.hash === undefined && x.text === undefined)).toBe(true);
    expect(s.cacheBreaks).toEqual([]);
  });

  it("not even a system message inserted mid-conversation (OpenAI)", () => {
    const x = openaiChat([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "My SSN is 123-45-6789" },
      { role: "system", content: "Summary: user said their SSN is 123-45-6789" },
    ]);
    const json = JSON.stringify(snap([x], "prefix"));
    expect(json).toContain("You are helpful.");
    expect(json).not.toContain("123-45-6789");
  });

  it("carry their cache breaks, so a committed baseline still knows it was broken", () => {
    const broken = loop({
      system: `${SYSTEM} t=2026-11-22T04:14:39Z`,
      system2: `${SYSTEM} t=2026-11-22T04:14:41Z`,
    });
    const path = join(tmp, "broken.json");
    writeSnapshot(path, snap(broken, "prefix"));
    const d = diffSnapshots(loadSnapshot(path), snap(broken));
    expect(d.base.cacheBreaks).toHaveLength(1);
    expect(d.failures).toEqual([]);
  });

  it("load from a committed snapshot or a session, interchangeably", () => {
    const x = loop();
    const sessionPath = join(tmp, "s.jsonl");
    for (const e of x) appendExchange(sessionPath, e);
    const snapPath = join(tmp, "tokenwire.snapshot.json");
    writeSnapshot(snapPath, snap(x, "prefix"));
    expect(JSON.parse(readFileSync(snapPath, "utf8")).tokenwire).toBe(1);
    expect(
      diffSnapshots(loadSnapshot(snapPath), loadSnapshot(sessionPath, "all")).delta.tokens,
    ).toBe(0);
  });

  it("never write a secret from the system prompt or a tool definition, and keep its token count", () => {
    const KEY = "sk-ant-api03-" + "K".repeat(40);
    const GH = "ghp_" + "G".repeat(36);
    const PEM =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA" +
      "Q".repeat(64) +
      "\n-----END RSA PRIVATE KEY-----";
    const system = `${SYSTEM}\nUse the key ${KEY} for billing.\n${PEM}\nThat is all.`;
    const x = loop({ system, tools: [{ name: "deploy", description: `Deploys with ${GH}.` }] });
    const committed = snap(x, "prefix");
    const json = JSON.stringify(committed);
    for (const secret of [KEY, GH, "MIIEpAIBAAKCAQEA", "QQQQQQQQ"])
      expect(json).not.toContain(secret);
    expect(json).toContain("[redacted: an sk- API key]");
    expect(json).toContain("[redacted: a GitHub token]");
    expect(json).toContain("[redacted: a private key]");
    expect(json).toContain("That is all.");
    // Counts are of what was sent, not of the placeholder.
    const sent = snap(x, "all");
    expect(committed.turns.map((t) => t.sections.map((s) => s.tokens))).toEqual(
      sent.turns.map((t) => t.sections.map((s) => s.tokens)),
    );
    // Both sides redact alike: no phantom change, and a PR comment never quotes the key.
    const d = diffSnapshots(committed, sent);
    expect(d.system.change).toBeNull();
    expect(d.failures).toEqual([]);
    const edited = snap(loop({ system: system.replace("for billing", "for refunds") }));
    const md = renderDiffMarkdown(diffSnapshots(committed, edited));
    expect(md).toContain("refunds");
    expect(md).not.toContain("KKKKKKKK");
  });

  it("say so when the only change is inside a redacted secret, and where", () => {
    const A = "sk-ant-api03-" + "A".repeat(40);
    const B = "sk-ant-api03-" + "B".repeat(40);
    const C = "ghp_" + "C".repeat(36);
    const D = "ghp_" + "D".repeat(36);
    const sys = (k1: string, k2: string) => `${SYSTEM}\nbilling key ${k1}\nrepo token ${k2}\nend.`;
    // Between runs: only the second secret changed.
    const d = diffSnapshots(
      snap(loop({ system: sys(A, C) }), "prefix"),
      snap(loop({ system: sys(A, D) })),
    );
    expect(d.system.change).not.toBeNull();
    expect(d.system.change!.redacted).toBe(true);
    // A committed baseline keeps no fingerprints, so which of the two changed is not known,
    // and the report does not guess.
    expect(d.system.change!.was).toBe("one of the 2 redacted secrets");
    const md = renderDiffMarkdown(d);
    expect(md).toMatch(/changed inside one of the 2 redacted secrets, the first at char/);
    // With one secret, it is known.
    const one = (k: string) => `${SYSTEM}\nbilling key ${k}\nend.`;
    const d1 = diffSnapshots(
      snap(loop({ system: one(A) }), "prefix"),
      snap(loop({ system: one(B) })),
    );
    expect(renderDiffText(d1)).toMatch(/changed inside \[redacted: an sk- API key\] at char/);
    for (const secret of ["AAAAAAAA", "CCCCCCCC", "DDDDDDDD"]) expect(md).not.toContain(secret);
    // Within a run: the second request re-renders the first secret. The break is located at
    // that placeholder, not at char 0 with nothing to show.
    const run = snap(loop({ system: sys(A, C), system2: sys(B, C) }));
    const [brk] = findCacheBreaks(run);
    expect(brk!.redacted).toBe(true);
    expect(brk!.was).toBe("[redacted: an sk- API key]");
    const redactedText = run.turns[0]!.sections[0]!.text!;
    expect(brk!.at).toBe(redactedText.indexOf("[redacted: an sk- API key]"));
    // The committed form keeps no secret fingerprints.
    const path = join(tmp, "secret-change.json");
    writeSnapshot(path, snap(loop({ system: sys(A, C) }), "prefix"));
    expect(readFileSync(path, "utf8")).not.toContain('"secrets"');
  });

  it("redact a baseline committed before redaction existed, quotes included", () => {
    const KEY = "sk-ant-api03-" + "Z".repeat(40);
    const old = {
      tokenwire: 1,
      version: "0.1.1",
      offline: true,
      turns: [
        {
          n: 1,
          kind: "anthropic-messages",
          model: "claude-sonnet-5",
          totalTokens: 100,
          exact: false,
          sections: [
            { kind: "system", tokens: 100, hash: "h1", text: `You use ${KEY} for billing.` },
          ],
        },
      ],
      cacheBreaks: [
        {
          turn: 2,
          previous: 1,
          where: "the system prompt",
          key: "the system prompt",
          inPrefix: true,
          at: 30,
          was: "ZZZZZZZZZZ",
          now: "YYYYYYYYYY",
          volatile: false,
          tokens: 100,
        },
      ],
    };
    const path = join(tmp, "pre-redaction.json");
    writeFileSync(path, JSON.stringify(old));
    const loaded = loadSnapshot(path);
    const json = JSON.stringify(loaded);
    expect(json).not.toContain("ZZZZZZZZZZ");
    expect(json).toContain("[redacted: an sk- API key]");
    expect(loaded.cacheBreaks![0]!.was).toBeUndefined();
    expect(loaded.cacheBreaks![0]!.at).toBe(30);
  });

  it("say clearly when a snapshot is from a newer format or has merge conflicts", () => {
    const future = join(tmp, "future.json");
    writeFileSync(future, JSON.stringify({ tokenwire: 2, turns: [] }));
    expect(() => loadSnapshot(future)).toThrow(
      /snapshot format 2; this tokenwire .* reads format 1/,
    );
    const conflicted = join(tmp, "conflict.json");
    writeFileSync(
      conflicted,
      '<<<<<<< HEAD\n{"tokenwire":1}\n=======\n{"tokenwire":1}\n>>>>>>> branch\n',
    );
    expect(() => loadSnapshot(conflicted)).toThrow(/merge-conflict markers/);
  });
});

describe("the PR comment", () => {
  it("is marked for in-place updates and leads with the verdict", () => {
    const md = renderDiffMarkdown(diffSnapshots(snap(loop(), "prefix"), snap(loop())));
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("| **Input tokens per run** |");
  });
});

describe("a request too large to record", () => {
  const truncated = (): Exchange => {
    const x = anthropicExchange({ messages: [user("big")] }, 2);
    return {
      ...x,
      request: {
        ...x.request,
        body: "[truncated: 9437184 bytes]",
        bytes: 9437184,
        truncated: true,
      },
    };
  };

  it("is reported as a gap by lint, not silently dropped", () => {
    const r = lintExchanges([...loop(), truncated()]);
    expect(r.turns).toHaveLength(2);
    expect(r.incomplete).toHaveLength(1);
    expect(r.incomplete[0]).toMatch(
      /#3 POST anthropic\/v1\/messages: the request body was 9\.0 MB/,
    );
    expect(r.incomplete[0]).toContain("not linted or counted");
  });

  it("is carried into a snapshot, and the diff warns about it", () => {
    const path = join(tmp, "truncated.jsonl");
    for (const e of renumber([...loop(), truncated()])) appendExchange(path, e);
    const head = loadSnapshot(path, "all");
    expect(head.incomplete).toHaveLength(1);
    const d = diffSnapshots(snap(loop(), "prefix"), head);
    expect(d.warnings.some((w) => w.startsWith("this run is missing a request: #3"))).toBe(true);
    expect(renderDiffText(d)).toContain("this run is missing a request");
  });
});
