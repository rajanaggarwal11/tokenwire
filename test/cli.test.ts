import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { appendExchange } from "../src/session.js";
import { anthropicExchange, conversation, prose } from "./helpers/session.js";
import { startUpstream } from "./helpers/upstream.js";
import type { Upstream } from "./helpers/upstream.js";

let tmp: string;
let upstream: Upstream;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "tokenwire-cli-"));
  upstream = await startUpstream();
});
afterAll(async () => {
  await upstream.close();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}
async function cli(...args: string[]): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const o = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((c) => ((stdout += String(c)), true));
  const e = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((c) => ((stderr += String(c)), true));
  try {
    const esc = String.fromCodePoint(0x1b);
    const strip = (s: string) => s.split(new RegExp(`${esc}\\[[0-9;]*m`, "g")).join("");
    const code = await run(args);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

function session(name: string, exchanges: ReturnType<typeof anthropicExchange>[]): string {
  const path = join(tmp, name);
  for (const x of exchanges) appendExchange(path, x);
  return path;
}

describe("usage", () => {
  it("--help documents the exit codes and the two promises", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Exit codes");
    expect(r.stdout).toContain("never modifies a request");
    expect(r.stdout).toContain("never contains a credential");
  });
  it("--version prints a version", async () => {
    expect((await cli("--version")).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("--list-rules names every rule", async () => {
    const r = await cli("--list-rules");
    for (const id of [
      "budget",
      "growth",
      "cache-miss",
      "secret-in-context",
      "injection-in-tool-result",
    ])
      expect(r.stdout).toContain(id);
  });
  it("exits 2 on a missing session, an unknown rule, or a bad number", async () => {
    expect((await cli("check", join(tmp, "nope.jsonl"))).code).toBe(2);
    const s = session("u.jsonl", [
      anthropicExchange({ messages: [{ role: "user", content: "hi" }], usage: { input: 10 } }),
    ]);
    const bad = await cli("check", s, "--only", "no-such-rule");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown rule "no-such-rule"');
    expect((await cli("check", s, "--budget", "lots")).code).toBe(2);
  });
  it("an unknown command is an error that names the closest one, not a proxy that wipes the session", async () => {
    const s = session("typo.jsonl", [
      anthropicExchange({ messages: [{ role: "user", content: "hi" }], usage: { input: 10 } }),
    ]);
    const before = readFileSync(s, "utf8");
    const r = await cli("chek", s);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "chek". Did you mean "check"?');
    // Nothing started, nothing written.
    expect(r.stderr).not.toContain("proxy on");
    expect(readFileSync(s, "utf8")).toBe(before);
    expect((await cli("snapshto")).stderr).toContain('Did you mean "snapshot"?');
    const far = await cli("deploy");
    expect(far.code).toBe(2);
    expect(far.stderr).toContain('unknown command "deploy"');
    expect(far.stderr).not.toContain("Did you mean");
  });
});

describe("check and report on a recorded session", () => {
  it("0 on a clean session, 1 on an error, 0 then 1 for warnings under --strict", async () => {
    const clean = session("clean.jsonl", [
      anthropicExchange({
        system: "Be brief.",
        messages: [{ role: "user", content: "hi" }],
        usage: { input: 20 },
      }),
    ]);
    const r = await cli("check", clean);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No problems found");

    const secret = session("secret.jsonl", [
      anthropicExchange({
        messages: [{ role: "user", content: `key: sk-live-${"B".repeat(30)}` }],
        usage: { input: 30 },
      }),
    ]);
    const e = await cli("check", secret);
    expect(e.code).toBe(1);
    expect(e.stdout).toContain("secret-in-context");
    expect(e.stdout).not.toContain("BBBB");

    const warn = session(
      "warn.jsonl",
      conversation(6, { system: prose(6000, "s"), usage: { input: 6500 } }),
    );
    expect((await cli("check", warn, "--only", "no-cache")).code).toBe(0);
    expect((await cli("check", warn, "--only", "no-cache", "--strict")).code).toBe(1);
    expect(
      (await cli("check", warn, "--ignore", "no-cache,unused-tools,growth,oversized-system")).code,
    ).toBe(0);
  });

  it("report prints the per-turn table; --json emits the documented shape", async () => {
    const s = session(
      "report.jsonl",
      conversation(3, {
        system: [{ text: prose(3000, "s"), cache: true }],
        usage: { input: 3200, cacheRead: 3000, output: 40 },
      }),
    );
    const r = await cli("report", s);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3 requests");
    expect(r.stdout).toMatch(/turn\s+input\s+cache r\/w\s+output\s+system\s+tools\s+history/);
    expect(r.stdout).toContain("3,200");
    const j = await cli("report", s, "--json");
    const report = JSON.parse(j.stdout) as {
      version: number;
      requests: number;
      turns: { n: number; input: number; exact: boolean; sections: { system: number } }[];
      summary: { total: number };
      findings: unknown[];
      rulesRun: string[];
    };
    expect(report.version).toBe(1);
    expect(report.requests).toBe(3);
    expect(report.turns[0]).toMatchObject({ n: 1, input: 3200, exact: true });
    expect(report.turns[0]?.sections.system).toBeGreaterThan(2500);
    expect(report.rulesRun).toHaveLength(10);
    expect(report.summary.total).toBe(report.findings.length);
  });

  it("--sections lists the last request's sections largest first, and the tools line names the biggest definitions", async () => {
    const s = session(
      "sections.jsonl",
      conversation(3, {
        system: prose(800, "s"),
        tools: [{ name: "big_tool", description: prose(400, "big") }, { name: "small_tool" }],
        usage: { input: 2000 },
      }),
    );
    const r = await cli("report", s, "--sections");
    expect(r.stdout).toContain("tools: 2 defined");
    expect(r.stdout).toMatch(/largest: big_tool [\d,]+ · small_tool [\d,]+/);
    expect(r.stdout).toContain("sections of turn 3, largest first");
    expect(r.stdout.indexOf("system")).toBeLessThan(r.stdout.indexOf("tool big_tool"));
  });

  it("budget reads a k or m suffix as a multiplier, decimals included", async () => {
    const s = session("suffix.jsonl", [
      anthropicExchange({ messages: [{ role: "user", content: "hi" }], usage: { input: 2_000 } }),
    ]);
    const r = await cli("check", s, "--budget", "1.5k", "--strict");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("budget 1,500");
    expect((await cli("check", s, "--budget", "0.002m", "--strict")).code).toBe(0);
    expect((await cli("check", s, "--budget", "40_000")).code).toBe(0);
    const bad = await cli("check", s, "--budget", "1.5x");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("like 40000, 40k or 1.5m");
  });

  it("check, report and snapshot say when a request was too large to record, instead of skipping it quietly", async () => {
    const ok = anthropicExchange({
      messages: [{ role: "user", content: "hi" }],
      usage: { input: 10 },
    });
    const big = anthropicExchange({ messages: [{ role: "user", content: "hi" }] }, 1);
    big.request = {
      ...big.request,
      body: "[truncated: 9437184 bytes]",
      bytes: 9437184,
      truncated: true,
    };
    const s = session("truncated.jsonl", [ok, big]);
    for (const cmd of ["check", "report"]) {
      const r = await cli(cmd, s);
      expect(r.stdout).toContain("#2 POST anthropic/v1/messages: the request body was 9.0 MB");
    }
    const json = JSON.parse((await cli("check", s, "--json")).stdout) as { incomplete: string[] };
    expect(json.incomplete).toHaveLength(1);
    const snapped = await cli("snapshot", s, "-o", join(tmp, "truncated.snapshot.json"));
    expect(snapped.code).toBe(0);
    expect(snapped.stderr).toContain("the request body was 9.0 MB");
  });

  it("budget accepts 40k", async () => {
    const s = session("budget.jsonl", [
      anthropicExchange({ messages: [{ role: "user", content: "hi" }], usage: { input: 50_000 } }),
    ]);
    const r = await cli("check", s, "--budget", "40k", "--strict");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("budget 40,000");
  });
});

describe("wrap", () => {
  it("runs a real child through the proxy, records its requests, reports, and never writes the key", async () => {
    const sessionFile = join(tmp, "wrap.jsonl");
    const script = `
      const base = process.env.ANTHROPIC_BASE_URL;
      if (!base) { console.error("no base url"); process.exit(9); }
      const key = "sk-ant-api03-" + "W".repeat(40);
      const call = (messages) => fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 10, system: "You are a helpful assistant.", messages }) }).then((r) => r.json());
      await call([{ role: "user", content: "read .env" }]);
      await call([{ role: "user", content: "read .env" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ANTHROPIC_API_KEY=" + key }] }]);
      console.log("child done");
    `;
    const r = await cli(
      "wrap",
      "--session",
      sessionFile,
      "--upstream",
      `anthropic=${upstream.url}`,
      "--",
      process.execPath,
      "--input-type=module",
      "-e",
      script,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("2 requests");
    expect(r.stdout).toContain("secret-in-context");
    expect(r.stderr).toContain("#1 POST anthropic/v1/messages");
    const file = readFileSync(sessionFile, "utf8");
    expect(file.split("\n").filter(Boolean)).toHaveLength(2);
    // The header is stripped; the body is content — it is exactly what gets linted.
    expect(file).toContain('"x-api-key":"[stripped]"');
    expect(file).toContain("ANTHROPIC_API_KEY=sk-ant-api03-");
    // The finding names the secret's kind and place, never the secret.
    expect(r.stdout).not.toContain("WWWWWWWW");
  }, 30_000);

  it("propagates the child's exit code when it fails", async () => {
    const r = await cli("wrap", "--no-record", "--", process.execPath, "-e", "process.exit(7)");
    expect(r.code).toBe(7);
  });

  it("exits 128 + the signal number when the child is killed by a signal", async () => {
    const r = await cli(
      "wrap",
      "--no-record",
      "--",
      process.execPath,
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    );
    expect(r.code).toBe(143);
  });

  it("exits 2 when the command cannot start", async () => {
    const r = await cli("wrap", "--no-record", "--", "/definitely/not/a/binary");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("could not start");
  });
});

describe("CI mode: wrap --offline, snapshot, diff", () => {
  const scenario = (extra: string) => `
    const base = process.env.ANTHROPIC_BASE_URL;
    const tools = [{ name: "get_invoice", description: "Fetch an invoice", input_schema: { type: "object" } }${extra}];
    const ask = (system, messages) => fetch(base + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-not-real" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, system, tools, messages }),
    }).then((r) => r.json());
    const first = await ask("You are the billing assistant.", [{ role: "user", content: "hi" }]);
    if (first.stop_reason !== "end_turn") process.exit(9);
  `;
  const record = (name: string, extra = "") =>
    cli(
      "wrap",
      "--offline",
      "--session",
      join(tmp, name),
      "--",
      process.execPath,
      "--input-type=module",
      "-e",
      scenario(extra),
    );

  it("records offline, snapshots, and diffs a change", async () => {
    const base = await record("ci-base.jsonl");
    expect(base.code).toBe(0);
    expect(base.stderr).toContain("offline capture — nothing is sent upstream");
    const snapPath = join(tmp, "tokenwire.snapshot.json");
    const s = await cli("snapshot", join(tmp, "ci-base.jsonl"), "-o", snapPath);
    expect(s.code).toBe(0);
    expect(s.stderr).toContain("1 request");

    expect((await cli("diff", snapPath, join(tmp, "ci-base.jsonl"))).code).toBe(0);

    await record(
      "ci-head.jsonl",
      `, { name: "search_kb", description: "${"Search the knowledge base. ".repeat(20)}", input_schema: { type: "object" } }`,
    );
    const md = await cli(
      "diff",
      snapPath,
      join(tmp, "ci-head.jsonl"),
      "--format",
      "markdown",
      "--max-increase",
      "10%",
    );
    expect(md.code).toBe(1);
    expect(md.stdout).toContain("<!-- tokenwire-diff -->");
    expect(md.stdout).toContain("`search_kb`");
    expect(md.stdout).toMatch(/over the 10% limit/);

    const json = await cli("diff", snapPath, join(tmp, "ci-head.jsonl"), "--format", "json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      version: 1,
      tools: { added: [{ name: "search_kb" }] },
    });
  }, 30_000);

  it("refuses bad diff options and a missing baseline", async () => {
    expect((await cli("diff")).code).toBe(2);
    expect((await cli("diff", join(tmp, "nope.json"))).stderr).toContain("no snapshot or session");
    const s = join(tmp, "ci-base.jsonl");
    expect((await cli("diff", s, s, "--runs-per-day", "100")).stderr).toContain(
      "--runs-per-day needs --price",
    );
    expect((await cli("diff", s, s, "--format", "html")).code).toBe(2);
    expect((await cli("diff", s, s, "--max-increase", "lots")).code).toBe(2);
    expect(
      (await cli("wrap", "--reply", "x", "--no-record", "--", process.execPath, "-e", "0")).stderr,
    ).toContain("--reply only applies with --offline");
  });
});

describe("CI mode: a run that measured nothing", () => {
  it("is an error, not a saving", async () => {
    const base = join(tmp, "ci-base.jsonl");
    const empty = join(tmp, "empty.jsonl");
    await cli("wrap", "--offline", "--session", empty, "--", process.execPath, "-e", "0");
    const r = await cli("diff", base, empty);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("has no chat requests");
  });
});

describe("CI mode: a typo must not pass a gate", () => {
  it("rejects unknown options, empty values and stray arguments", async () => {
    const s = join(tmp, "ci-base.jsonl");
    expect((await cli("diff", s, s, "--max-incrase", "10%")).code).toBe(2);
    expect((await cli("diff", s, s, "--max-increase", "%")).code).toBe(2);
    expect((await cli("diff", s, s, "--price", " ")).code).toBe(2);
    const stray = await cli("diff", s, s, "--max-increase", "10", "%");
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("Quote option values");
  });

  it("wrap --offline that recorded no chat request is an error", async () => {
    const r = await cli("wrap", "--offline", "--no-record", "--", process.execPath, "-e", "0");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("recorded no chat requests");
  });
});
