import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * npm installs a bin as a symlink. A main-module guard that compares paths
 * without resolving them makes the CLI a no-op when run that way, which is
 * exactly how `npx tokenwire` runs it. So the built binary is executed through
 * a symlink here. Needs `pnpm build` first (the check script does that).
 */
const dist = resolve("dist/cli.js");
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "tokenwire-bin-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!existsSync(dist))("the built binary", () => {
  it("does something when executed through a symlink", () => {
    const link = join(tmp, "tokenwire");
    symlinkSync(dist, link);
    const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    expect(help).toContain("Exit codes");
  });
});

/** Runs the built CLI; resolves with its exit code and output once it exits. */
function start(args: string[], cwd: string) {
  const child = spawn(process.execPath, [dist, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += String(d)));
  child.stderr!.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) =>
    child.on("exit", (code) => r({ code, stdout, stderr })),
  );
  return { child, exited, stderr: () => stderr };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!existsSync(dist))("signals, through the built binary", () => {
  let running: ChildProcess | undefined;
  let grandchild: number | undefined;
  afterAll(() => {
    if (running && running.exitCode === null) running.kill("SIGKILL");
    if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
  });

  it("with no command, starts the proxy, and reports on Ctrl-C", async () => {
    const run = start(["--no-record"], tmp);
    running = run.child;
    await until(() => run.stderr().includes("proxy on http://127.0.0.1:"));
    run.child.kill("SIGINT");
    const r = await run.exited;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tokenwire");
    expect(r.stdout).toContain("no chat requests recorded");
  }, 20_000);

  it("wrap passes SIGTERM on to the command, and exits 128 + 15 when it dies of it", async () => {
    const pidFile = join(tmp, "child.pid");
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const run = start(["wrap", "--no-record", "--", process.execPath, "-e", script], tmp);
    running = run.child;
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    grandchild = childPid;
    // Only tokenwire is signalled, as a supervisor or CI runner would.
    run.child.kill("SIGTERM");
    const r = await run.exited;
    expect(r.code).toBe(143);
    await until(() => !alive(childPid), 3000);
  }, 20_000);

  it("wrap does not pass SIGINT on (the terminal already sent it to the command), survives it, and forwards SIGHUP", async () => {
    const pidFile = join(tmp, "child2.pid");
    const sigFile = join(tmp, "child2.sigint");
    const script = `const fs = require("fs");
      process.on("SIGINT", () => fs.appendFileSync(${JSON.stringify(sigFile)}, "SIGINT\\n"));
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);`;
    const run = start(["wrap", "--no-record", "--", process.execPath, "-e", script], tmp);
    running = run.child;
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    grandchild = childPid;
    // A SIGINT to tokenwire alone, as a terminal's Ctrl-C reaches it alongside the command.
    run.child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(sigFile)).toBe(false);
    expect(run.child.exitCode).toBeNull();
    expect(alive(childPid)).toBe(true);
    run.child.kill("SIGHUP");
    const r = await run.exited;
    expect(r.code).toBe(129);
    await until(() => !alive(childPid), 3000);
  }, 20_000);
});
