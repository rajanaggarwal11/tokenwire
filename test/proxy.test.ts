import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendExchange, readSession, startProxy } from "../src/index.js";
import type { Exchange, RunningProxy } from "../src/index.js";
import { startUpstream } from "./helpers/upstream.js";
import type { Upstream } from "./helpers/upstream.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const API_KEY = "sk-ant-api03-THIS-MUST-NEVER-BE-WRITTEN-DOWN-0123456789abcdef";
const BEARER = "Bearer ghu_ANOTHER_SECRET_THAT_MUST_NOT_LEAK_0123456789";

let upstream: Upstream;
let proxy: RunningProxy;
let tmp: string;
const exchanges: Exchange[] = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "tokenwire-proxy-"));
  upstream = await startUpstream();
  proxy = await startProxy({
    upstreams: { anthropic: upstream.url, openai: upstream.url, dead: "http://127.0.0.1:1" },
    onExchange: (x) => {
      exchanges.push(x);
      appendExchange(join(tmp, "session.jsonl"), x);
    },
  });
});
afterAll(async () => {
  await proxy.close();
  await upstream.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Wait for the exchange the proxy records after the client has its response. */
async function lastExchange(): Promise<Exchange> {
  for (let i = 0; i < 50 && exchanges.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  const before = exchanges.length;
  for (let i = 0; i < 50 && exchanges.length < before; i++)
    await new Promise((r) => setTimeout(r, 10));
  return exchanges[exchanges.length - 1]!;
}

describe("the wire", () => {
  it("forwards the request body byte for byte, with every header the client sent", async () => {
    const body = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi ☃" }],
    });
    const res = await fetch(`${proxy.url}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-beta": "prompt-caching-2024-07-31",
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    expect(res.status).toBe(200);
    const got = upstream.received.at(-1)!;
    expect(got.path).toBe("/v1/messages?beta=true");
    expect(sha(got.body)).toBe(sha(body));
    expect(got.headers["x-api-key"]).toBe(API_KEY);
    expect(got.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(got.headers["anthropic-version"]).toBe("2023-06-01");
    expect(got.headers.host).toBe(new URL(upstream.url).host);
  });

  it("returns the response byte for byte, status and headers included", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const text = Buffer.from(await res.arrayBuffer());
    expect(sha(text)).toBe(sha(upstream.sent.at(-1)!));
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("streams SSE through unchanged and still reads usage and tool calls off the side", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = Buffer.from(await res.arrayBuffer());
    expect(sha(text)).toBe(sha(upstream.sent.at(-1)!));
    const x = await lastExchange();
    expect(x.stream).toBe(true);
    expect(x.kind).toBe("anthropic-messages");
    expect(x.response.usage).toEqual({
      input: 1200,
      output: 42,
      cacheRead: 800,
      cacheWrite: 0,
      source: "provider",
    });
    expect(x.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
    expect(x.response.text).toBe("Checking the weather.");
  });

  it("passes a gzip response through still compressed, and records it decoded", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages?gzip=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(((await res.json()) as { id: string }).id).toBe("msg_2");
    const x = await lastExchange();
    expect(x.response.usage).toEqual({
      input: 2200,
      output: 17,
      cacheRead: 0,
      cacheWrite: 1000,
      source: "provider",
    });
    expect(x.response.toolCalls).toEqual([{ name: "get_weather", input: { city: "Delhi" } }]);
  });

  it("pipes a 5 MB stream without buffering it whole", async () => {
    const res = await fetch(`${proxy.url}/openai/big`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(5 * 1024 * 1024);
    expect(sha(buf)).toBe(sha(upstream.sent.at(-1)!));
  });

  it("answers 404 for an unknown upstream and 502 for an unreachable one, and says which", async () => {
    const unknown = await fetch(`${proxy.url}/nope/v1/messages`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('no upstream named "nope"');
    const dead = await fetch(`${proxy.url}/dead/v1/messages`, { method: "POST", body: "{}" });
    expect(dead.status).toBe(502);
    expect(await dead.text()).toContain("unreachable");
  });
});

describe("the three formats", () => {
  it("OpenAI chat, streamed with usage: assembles the split tool call and reads the final usage chunk", async () => {
    await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: BEARER },
      body: JSON.stringify({
        model: "gpt",
        stream: true,
        stream_options: { include_usage: true },
        messages: [],
      }),
    });
    const x = await lastExchange();
    expect(x.kind).toBe("openai-chat");
    expect(x.response.usage).toEqual({
      input: 900,
      output: 30,
      cacheRead: 512,
      cacheWrite: 0,
      source: "provider",
    });
    expect(x.response.toolCalls).toEqual([{ name: "get_weather", input: { city: "Delhi" } }]);
    expect(x.response.text).toBe("Sure, checking.");
  });

  it("OpenAI chat, streamed without usage: says so instead of inventing numbers", async () => {
    await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", stream: true, messages: [] }),
    });
    const x = await lastExchange();
    expect(x.response.usage.source).toBe("none");
    expect(x.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
  });

  it("OpenAI Responses, both ways", async () => {
    await fetch(`${proxy.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", input: "hi" }),
    });
    const whole = await lastExchange();
    expect(whole.kind).toBe("openai-responses");
    expect(whole.response.usage).toEqual({
      input: 1500,
      output: 25,
      cacheRead: 1024,
      cacheWrite: 0,
      source: "provider",
    });
    expect(whole.response.text).toBe("Looking it up.");
    await fetch(`${proxy.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt", input: "hi", stream: true }),
    });
    const streamed = await lastExchange();
    expect(streamed.response.usage.input).toBe(1500);
    expect(streamed.response.toolCalls.map((t) => t.name)).toEqual(["get_weather"]);
    expect(streamed.response.text).toBe("Looking it up.");
  });
});

describe("the record", () => {
  it("never contains a credential, in any header, in any exchange", async () => {
    await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        authorization: BEARER,
        cookie: "session=SECRETCOOKIE",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    await lastExchange();
    const file = readFileSync(join(tmp, "session.jsonl"), "utf8");
    expect(file).not.toContain(API_KEY);
    expect(file).not.toContain("ghu_ANOTHER_SECRET");
    expect(file).not.toContain("SECRETCOOKIE");
    expect(file).toContain('"x-api-key":"[stripped]"');
    const back = readSession(join(tmp, "session.jsonl"));
    expect(back.length).toBe(exchanges.length);
    expect(
      back.at(-1)!.request.headers["anthropic-version"] ??
        back.at(-1)!.request.headers["content-type"],
    ).toBeDefined();
  });

  it("keeps the parsed request body and the model", async () => {
    const x = exchanges.find((e) => e.model === "claude-sonnet-5")!;
    expect(x.path).toBe("/v1/messages?beta=true");
    expect((x.request.body as { messages: { content: string }[] }).messages[0]?.content).toBe(
      "hi ☃",
    );
    expect(x.request.headers["x-api-key"]).toBe("[stripped]");
    expect(x.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("what reaches the request handler", () => {
  it("answers 404 for an upstream named after an Object.prototype key, and keeps serving", async () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const res = await fetch(`${proxy.url}/${name}/x`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(`no upstream named "${name}"`);
    }
    const after = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(after.status).toBe(200);
  });

  it("answers 400 for a request target it cannot parse, and keeps serving", async () => {
    const { port } = new URL(proxy.url);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1", () =>
        socket.write("GET http://[ HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n"),
      );
      let data = "";
      socket.on("data", (d) => (data += String(d)));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect((await fetch(`${proxy.url}/nope/x`)).status).toBe(404);
  });
});

describe("when one side goes away", () => {
  /** An upstream that misbehaves on purpose, and says what happened to the requests it got. */
  let faulty: http.Server;
  let faultyUrl: string;
  let p: RunningProxy;
  const recorded: Exchange[] = [];
  let upstreamSawClose: () => void = () => {};
  const upstreamClosed = () =>
    new Promise<void>((resolve) => {
      upstreamSawClose = resolve;
    });

  beforeAll(async () => {
    faulty = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/reset") {
        // Headers and one SSE event, then the connection dies mid-stream.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (req.url === "/hang") {
        // Never answers; reports when the proxy gives up on it.
        req.socket.on("close", () => upstreamSawClose());
        return;
      }
      if (req.url === "/hang-mid-stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
        req.socket.on("close", () => upstreamSawClose());
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => faulty.listen(0, "127.0.0.1", () => r()));
    faultyUrl = `http://127.0.0.1:${(faulty.address() as net.AddressInfo).port}`;
    p = await startProxy({ upstreams: { faulty: faultyUrl }, onExchange: (x) => recorded.push(x) });
  });
  afterAll(async () => {
    await p.close();
    faulty.closeAllConnections();
    await new Promise((r) => faulty.close(r));
  });

  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };

  it("an upstream that dies mid-stream ends the client's response promptly, as a failure", async () => {
    const started = Date.now();
    const res = await fetch(`${p.url}/faulty/reset`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    // The body must fail, not hang and not look complete.
    await expect(res.text()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await until(() => recorded.some((x) => x.path === "/reset"))).toBe(true);
    const x = recorded.find((e) => e.path === "/reset")!;
    expect(x.error).toMatch(/failed mid-response/);
    expect(x.response.status).toBe(200);
    // The proxy is still up.
    expect((await fetch(`${p.url}/nope/x`)).status).toBe(404);
  });

  it("a client that gives up before the response destroys the upstream request", async () => {
    const closed = upstreamClosed();
    const ac = new AbortController();
    const pending = fetch(`${p.url}/faulty/hang`, {
      method: "POST",
      body: "{}",
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(pending).rejects.toThrow();
    await expect(
      Promise.race([
        closed,
        new Promise((_, no) => setTimeout(() => no(new Error("leaked")), 1500)),
      ]),
    ).resolves.toBeUndefined();
    expect(await until(() => recorded.some((x) => x.path === "/hang"))).toBe(true);
    expect(recorded.find((x) => x.path === "/hang")!.error).toMatch(/client closed/);
  });

  it("a client that gives up mid-stream destroys the upstream request", async () => {
    const closed = upstreamClosed();
    const ac = new AbortController();
    const res = await fetch(`${p.url}/faulty/hang-mid-stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await expect(
      Promise.race([
        closed,
        new Promise((_, no) => setTimeout(() => no(new Error("leaked")), 1500)),
      ]),
    ).resolves.toBeUndefined();
    expect(await until(() => recorded.some((x) => x.path === "/hang-mid-stream"))).toBe(true);
    const x = recorded.find((e) => e.path === "/hang-mid-stream")!;
    expect(x.error).toMatch(/client closed/);
    expect(x.response.status).toBe(200);
  });
});

describe("bodies over the record limit", () => {
  it("marks a truncated request instead of recording a fragment", async () => {
    const got: Exchange[] = [];
    const small = await startProxy({
      upstreams: { anthropic: upstream.url },
      maxRecordBytes: 1024,
      onExchange: (x) => got.push(x),
    });
    try {
      const body = JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x".repeat(4096) }],
      });
      const res = await fetch(`${small.url}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(200);
      // The wire carried all of it.
      expect(sha(upstream.received.at(-1)!.body)).toBe(sha(body));
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
      const x = got[0]!;
      expect(x.request.truncated).toBe(true);
      expect(x.request.bytes).toBe(Buffer.byteLength(body));
      expect(x.request.body).toBe(`[truncated: ${Buffer.byteLength(body)} bytes]`);
    } finally {
      await small.close();
    }
  });
});
