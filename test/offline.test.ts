import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startProxy } from "../src/proxy.js";
import type { RunningProxy } from "../src/proxy.js";
import type { Exchange } from "../src/types.js";
import { startUpstream } from "./helpers/upstream.js";
import type { Upstream } from "./helpers/upstream.js";

let proxy: RunningProxy;
let local: Upstream;
const recorded: Exchange[] = [];

beforeAll(async () => {
  local = await startUpstream();
  proxy = await startProxy({
    offline: { reply: "noted" },
    upstreams: { local: local.url },
    onExchange: (x) => recorded.push(x),
  });
});
afterAll(async () => {
  await proxy.close();
  await local.close();
});

const settle = () => new Promise((r) => setTimeout(r, 50));
const post = (path: string, body: unknown) =>
  fetch(`${proxy.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-secret",
      authorization: "Bearer sk-secret",
    },
    body: JSON.stringify(body),
  });

const cases = [
  {
    path: "/anthropic/v1/messages",
    kind: "anthropic-messages",
    body: {
      model: "claude-sonnet-5",
      max_tokens: 10,
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    path: "/openai/v1/chat/completions",
    kind: "openai-chat",
    body: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
  },
  {
    path: "/openai/v1/responses",
    kind: "openai-responses",
    body: { model: "gpt-5", instructions: "be brief", input: "hi" },
  },
] as const;

describe("--offline", () => {
  for (const c of cases) {
    for (const stream of [false, true]) {
      it(`${c.kind}${stream ? ", streamed" : ""}: answers locally in the right format and records the request exactly`, async () => {
        const before = recorded.length;
        const res = await post(c.path, { ...c.body, ...(stream ? { stream: true } : {}) });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-tokenwire-offline")).toBe("1");
        expect(res.headers.get("content-type")).toContain(
          stream ? "text/event-stream" : "application/json",
        );
        await res.text();
        await settle();
        const x = recorded[before]!;
        expect(x).toMatchObject({ kind: c.kind, stream, offline: true });
        // tokenwire's own parser reads the reply back out of every format.
        expect(x.response.text).toBe("noted");
        // Zero usage from a stand-in is not a measurement.
        expect(x.response.usage.source).toBe("none");
        expect(x.request.body).toEqual({ ...c.body, ...(stream ? { stream: true } : {}) });
        expect(x.request.headers["x-api-key"]).toBe("[stripped]");
        expect(x.request.headers.authorization).toBe("[stripped]");
      });
    }
  }

  it("answers count_tokens and model listings, and refuses anything else without sending it", async () => {
    expect(
      await (await post("/anthropic/v1/messages/count_tokens", { messages: [] })).json(),
    ).toEqual({ input_tokens: 0 });
    const models = (await (await fetch(`${proxy.url}/openai/v1/models`)).json()) as {
      data: unknown[];
    };
    expect(models.data).toEqual([]);
    const res = await post("/openai/v1/embeddings", { input: "x" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("was not sent anywhere");
  });

  it("still forwards an upstream you named explicitly", async () => {
    const before = local.received.length;
    const res = await post("/local/v1/messages", cases[0].body);
    await res.text();
    expect(local.received.length).toBe(before + 1);
    await settle();
    expect(recorded.at(-1)!.offline).toBeUndefined();
  });

  it("closes its stand-in with the proxy", async () => {
    const p = await startProxy({ offline: {} });
    await p.close();
    await expect(fetch(`${p.url}/anthropic/v1/messages`, { method: "POST" })).rejects.toThrow();
  });
});

describe("--offline answers what the request demands", () => {
  const ask = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${proxy.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body:
        typeof body === "string" || body instanceof Uint8Array
          ? (body as never)
          : JSON.stringify(body),
    });
    return res;
  };
  const schema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      items: { type: "array", items: { $ref: "#/$defs/item" }, minItems: 1 },
      status: { enum: ["open", "closed"] },
    },
    required: ["id", "items", "status"],
    $defs: { item: { type: "object", properties: { qty: { type: "integer", minimum: 1 } } } },
  };
  const expected = {
    id: "00000000-0000-4000-8000-000000000000",
    items: [{ qty: 1 }],
    status: "open",
  };

  it("sampleFromSchema follows refs, honours enums, minimums and formats", async () => {
    const { sampleFromSchema } = await import("../src/offline.js");
    expect(sampleFromSchema(schema)).toEqual(expected);
    expect(sampleFromSchema({ anyOf: [{ type: "null" }, { type: "boolean" }] })).toBe(false);
    expect(sampleFromSchema({ type: ["null", "number"], exclusiveMinimum: 0 })).toBe(1);
  });

  it("Anthropic: a forced tool gets a tool_use with schema-shaped input", async () => {
    const r = (await (
      await ask("/anthropic/v1/messages", {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "lookup", input_schema: schema }],
        tool_choice: { type: "tool", name: "lookup" },
      })
    ).json()) as { stop_reason: string; content: { type: string; input: unknown }[] };
    expect(r.stop_reason).toBe("tool_use");
    expect(r.content[0]).toMatchObject({ type: "tool_use", input: expected });
  });

  it("Anthropic: structured output gets JSON that matches the schema", async () => {
    const r = (await (
      await ask("/anthropic/v1/messages", {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        output_config: { format: { type: "json_schema", schema } },
      })
    ).json()) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text)).toEqual(expected);
  });

  it("OpenAI chat: tool_choice required, json_schema, json_object", async () => {
    const tools = [{ type: "function", function: { name: "lookup", parameters: schema } }];
    const forced = (await (
      await ask("/openai/v1/chat/completions", {
        model: "g",
        messages: [],
        tools,
        tool_choice: "required",
      })
    ).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { function: { arguments: string } }[] };
      }[];
    };
    expect(forced.choices[0]!.finish_reason).toBe("tool_calls");
    expect(JSON.parse(forced.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual(
      expected,
    );
    const structured = (await (
      await ask("/openai/v1/chat/completions", {
        model: "g",
        messages: [],
        response_format: { type: "json_schema", json_schema: { name: "x", schema } },
      })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(structured.choices[0]!.message.content)).toEqual(expected);
    const obj = (await (
      await ask("/openai/v1/chat/completions", {
        model: "g",
        messages: [],
        response_format: { type: "json_object" },
      })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(obj.choices[0]!.message.content).toBe("{}");
  });

  it("OpenAI Responses: a forced function call, streamed", async () => {
    const res = await ask("/openai/v1/responses", {
      model: "g",
      input: "x",
      stream: true,
      tools: [{ type: "function", name: "lookup", parameters: schema }],
      tool_choice: { type: "function", name: "lookup" },
    });
    const text = await res.text();
    expect(text).toContain("response.function_call_arguments.done");
    expect(text).toContain('"type":"function_call"');
  });

  it("OpenAI chat stream sends the usage chunk when include_usage asks for it", async () => {
    const text = await (
      await ask("/openai/v1/chat/completions", {
        model: "g",
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
      })
    ).text();
    expect(text).toContain('"choices":[],"usage":{"prompt_tokens":0');
  });

  it("reads a gzip-compressed request body", async () => {
    const { gzipSync } = await import("node:zlib");
    const res = await ask(
      "/anthropic/v1/messages",
      gzipSync(
        JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "x" }] }),
      ),
      { "content-encoding": "gzip" },
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
  });

  it("puts a placeholder key in the environment, replacing any real one", async () => {
    const { OFFLINE_KEY } = await import("../src/offline.js");
    expect(proxy.env.ANTHROPIC_API_KEY).toBe(OFFLINE_KEY);
    expect(proxy.env.OPENAI_API_KEY).toBe(OFFLINE_KEY);
    const online = await startProxy({});
    expect(online.env.ANTHROPIC_API_KEY).toBeUndefined();
    await online.close();
  });
});
