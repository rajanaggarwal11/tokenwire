import http from "node:http";
import { decodeBody } from "./decode.js";
import { apiKindOf } from "./exchange.js";

/**
 * A stand-in for api.anthropic.com and api.openai.com that answers every chat request
 * at once, without a model, in the wire format the client asked for — streaming or
 * not. Behind the proxy it turns `tokenwire wrap --offline` into a capture: the request
 * your app builds is recorded exactly, and answered here instead of by a provider. The
 * run costs nothing and comes out the same every time. That is what a CI check wants.
 *
 * The answer is shaped to what the request demands, so the SDK's own parsing succeeds:
 *
 *  - a forced tool (`tool_choice` naming one, or `any` / `required`) gets a tool call
 *    with arguments built from that tool's input schema;
 *  - structured output (a JSON schema in `output_config` / `response_format` /
 *    `text.format`) gets JSON built from the schema;
 *  - anything else gets `reply` (default: empty), and ends the turn — so an agent loop
 *    stops after its first request, which carries the system prompt, the tool
 *    definitions and the opening message: most of the bill, and nearly every cache break.
 */
export interface OfflineUpstream {
  url: string;
  close(): Promise<void>;
}

/** The placeholder API key `wrap --offline` puts in the environment, in place of any real one. */
export const OFFLINE_KEY = "tokenwire-offline-no-real-key";

const ID = "tokenwire_offline";
/** Upper bound on a sampled string's length or array's size, whatever the schema asks. */
const MAX_SAMPLE = 64;
/**
 * Upper bound on the values in one whole sample. Per-array caps alone multiply: four
 * nested arrays of `minItems: 64` are 16.7 million values. Past this budget, arrays
 * stop growing and nested values take their smallest form, so a sample stays under a
 * megabyte, whatever the schema. A 64 × 64 grid of 64-character strings still fits.
 */
const MAX_NODES = 10_000;
const PAD = "x".repeat(MAX_SAMPLE);
type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

/**
 * A value that satisfies a JSON schema well enough for an SDK's parser and a typical
 * zod or pydantic model: required shapes present, enums and consts honoured, formats
 * plausible. Local `$ref`s (`#/$defs/…`, `#/definitions/…`) are followed. The whole
 * value is bounded (`MAX_NODES`); a schema that demands more than that gets a smaller,
 * possibly non-conforming value rather than an unbounded one.
 */
export function sampleFromSchema(schema: unknown): unknown {
  return sample(schema, { root: schema, left: MAX_NODES }, 0);
}

interface Budget {
  root: unknown;
  /** Values still allowed in this sample. */
  left: number;
}

function sample(schema: unknown, budget: Budget, depth: number): unknown {
  const s = obj(schema);
  // Every value costs one, including the null that ends a too-deep or circular schema.
  budget.left--;
  const spent = budget.left < 0;
  if (depth > 12) return null;
  const { root } = budget;
  if (typeof s.$ref === "string" && s.$ref.startsWith("#/")) {
    let target: unknown = root;
    for (const part of s.$ref.slice(2).split("/"))
      target = obj(target)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return sample(target, budget, depth + 1);
  }
  // A value copied from the schema costs what it weighs, so repeating a large one is bounded too.
  const given = (v: unknown) => {
    budget.left -= Math.floor((JSON.stringify(v)?.length ?? 0) / MAX_SAMPLE);
    return v;
  };
  if ("const" in s) return given(s.const);
  if (Array.isArray(s.enum) && s.enum.length) return given(s.enum[0]);
  if ("default" in s) return given(s.default);
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = s[key];
    if (Array.isArray(options) && options.length) {
      const nonNull = options.find((o) => obj(o).type !== "null") ?? options[0];
      return sample(nonNull, budget, depth + 1);
    }
  }
  if (Array.isArray(s.allOf)) {
    return Object.assign({}, ...s.allOf.map((part) => obj(sample(part, budget, depth + 1))));
  }
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== "null") ?? s.type[0]) : s.type;
  switch (type) {
    case "object":
    case undefined: {
      if ((type === undefined && !s.properties) || spent) return {};
      const out: Json = {};
      for (const [name, prop] of Object.entries(obj(s.properties))) {
        if (budget.left <= 0) break;
        budget.left -= Math.floor(name.length / MAX_SAMPLE);
        out[name] = sample(prop, budget, depth + 1);
      }
      return out;
    }
    case "array": {
      // The schema comes from the request; a sample only needs to be valid, not large.
      const n = Math.min(MAX_SAMPLE, Math.max(0, Math.floor(Number(s.minItems) || 0)));
      const out: unknown[] = [];
      while (out.length < n && budget.left > 0) out.push(sample(s.items, budget, depth + 1));
      return out;
    }
    case "string": {
      const formats: Record<string, string> = {
        "date-time": "1970-01-01T00:00:00Z",
        date: "1970-01-01",
        time: "00:00:00",
        email: "user@example.com",
        uri: "https://example.com",
        url: "https://example.com",
        uuid: "00000000-0000-4000-8000-000000000000",
      };
      const f = typeof s.format === "string" ? formats[s.format] : undefined;
      if (f) return f;
      // Sliced from a fixed string: the request's schema can shorten it, never grow it.
      return PAD.slice(0, Math.max(0, Math.floor(Number(s.minLength) || 0)));
    }
    case "integer":
    case "number": {
      if (typeof s.minimum === "number") return s.minimum;
      if (typeof s.exclusiveMinimum === "number") return s.exclusiveMinimum + 1;
      return 0;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

/** What the stand-in says back: text, or a call to one tool. */
type Answer = { text: string } | { tool: string; input: unknown };

function toolsOf(body: Json, kind: "anthropic" | "chat" | "responses") {
  const list = Array.isArray(body.tools) ? body.tools : [];
  return list.map((t) => {
    const o = obj(t);
    if (kind === "chat") {
      const f = obj(o.function);
      return { name: String(f.name ?? ""), schema: f.parameters };
    }
    return {
      name: String(o.name ?? ""),
      schema: kind === "anthropic" ? o.input_schema : o.parameters,
    };
  });
}

function answerFor(body: Json, kind: "anthropic" | "chat" | "responses", reply: string): Answer {
  const tools = toolsOf(body, kind);
  const choice = body.tool_choice;
  const c = obj(choice);
  let forced: string | undefined;
  if (kind === "anthropic") {
    if (c.type === "tool" && typeof c.name === "string") forced = c.name;
    else if (c.type === "any") forced = tools[0]?.name;
  } else if (kind === "chat") {
    if (c.type === "function") forced = String(obj(c.function).name ?? "");
    else if (choice === "required") forced = tools[0]?.name;
  } else {
    if (c.type === "function" && typeof c.name === "string") forced = c.name;
    else if (choice === "required") forced = tools.find((t) => t.name)?.name;
  }
  if (forced) {
    const tool = tools.find((t) => t.name === forced);
    return { tool: forced, input: sampleFromSchema(tool?.schema ?? {}) };
  }

  // Structured output: Anthropic output_config.format (and the older output_format),
  // OpenAI chat response_format, OpenAI Responses text.format.
  const format =
    kind === "anthropic"
      ? obj(obj(body.output_config).format ?? body.output_format)
      : kind === "chat"
        ? obj(body.response_format)
        : obj(obj(body.text).format);
  if (format.type === "json_schema") {
    const schema = kind === "chat" ? obj(format.json_schema).schema : format.schema;
    return { text: JSON.stringify(sampleFromSchema(schema ?? {})) };
  }
  if (format.type === "json_object") return { text: "{}" };
  return { text: reply };
}

function sse(events: { event?: string; data: unknown }[], done = false): string {
  return (
    events
      .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`)
      .join("") + (done ? "data: [DONE]\n\n" : "")
  );
}

function anthropic(model: string, stream: boolean, answer: Answer) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const block =
    "tool" in answer
      ? { type: "tool_use", id: `toolu_${ID}`, name: answer.tool, input: answer.input }
      : { type: "text", text: answer.text };
  const stop = "tool" in answer ? "tool_use" : "end_turn";
  const message = {
    id: `msg_${ID}`,
    type: "message",
    role: "assistant",
    model,
    content: [block],
    stop_reason: stop,
    stop_sequence: null,
    usage,
  };
  if (!stream) return { type: "application/json", body: JSON.stringify(message) };
  const start = "tool" in answer ? { ...block, input: {} } : { type: "text", text: "" };
  const delta =
    "tool" in answer
      ? { type: "input_json_delta", partial_json: JSON.stringify(answer.input) }
      : answer.text
        ? { type: "text_delta", text: answer.text }
        : undefined;
  return {
    type: "text/event-stream",
    body: sse([
      {
        event: "message_start",
        data: { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: start },
      },
      ...(delta
        ? [{ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta } }]
        : []),
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: { output_tokens: 0 },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]),
  };
}

function openaiChat(model: string, stream: boolean, answer: Answer, includeUsage: boolean) {
  const created = Math.floor(Date.now() / 1000);
  const base = { id: `chatcmpl-${ID}`, created, model, system_fingerprint: null };
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const call =
    "tool" in answer
      ? {
          id: `call_${ID}`,
          type: "function",
          function: { name: answer.tool, arguments: JSON.stringify(answer.input) },
        }
      : undefined;
  const finish = call ? "tool_calls" : "stop";
  if (!stream) {
    return {
      type: "application/json",
      body: JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: call ? null : (answer as { text: string }).text,
              refusal: null,
              ...(call ? { tool_calls: [call] } : {}),
            },
            finish_reason: finish,
            logprobs: null,
          },
        ],
        usage,
      }),
    };
  }
  const chunk = (delta: Json, finishReason: string | null) => ({
    data: {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    },
  });
  const first = call
    ? chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, ...call }] }, null)
    : chunk({ role: "assistant", content: (answer as { text: string }).text }, null);
  const events = [first, chunk({}, finish)];
  // stream_options.include_usage: a last chunk with no choices and the usage.
  if (includeUsage)
    events.push({
      data: { ...base, object: "chat.completion.chunk", choices: [], usage } as never,
    });
  return { type: "text/event-stream", body: sse(events, true) };
}

function openaiResponses(model: string, stream: boolean, answer: Answer) {
  const created_at = Math.floor(Date.now() / 1000);
  const text = "tool" in answer ? "" : answer.text;
  const item =
    "tool" in answer
      ? {
          type: "function_call",
          id: `fc_${ID}`,
          call_id: `call_${ID}`,
          name: answer.tool,
          arguments: JSON.stringify(answer.input),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${ID}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        };
  const response = (status: string, output: unknown[]) => ({
    id: `resp_${ID}`,
    object: "response",
    created_at,
    status,
    model,
    output,
    output_text: status === "completed" ? text : "",
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
  if (!stream)
    return { type: "application/json", body: JSON.stringify(response("completed", [item])) };
  // The SDKs assemble the final response from the item and part events, so the stream
  // carries the full sequence, not just response.completed.
  const events: { type: string; [k: string]: unknown }[] = [
    { type: "response.created", response: response("in_progress", []) },
    { type: "response.in_progress", response: response("in_progress", []) },
  ];
  if (item.type === "function_call") {
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: (item as { arguments: string }).arguments,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        arguments: (item as { arguments: string }).arguments,
      },
    );
  } else {
    const part = { type: "output_text", text: "", annotations: [] };
    const at = { item_id: item.id, output_index: 0, content_index: 0 };
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      { type: "response.content_part.added", ...at, part },
      ...(text ? [{ type: "response.output_text.delta", ...at, delta: text }] : []),
      { type: "response.output_text.done", ...at, text },
      { type: "response.content_part.done", ...at, part: { ...part, text } },
    );
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: response("completed", [item]) },
  );
  return {
    type: "text/event-stream",
    body: sse(events.map((e, i) => ({ event: e.type, data: { ...e, sequence_number: i } }))),
  };
}

export function startOfflineUpstream(options: { reply?: string } = {}): Promise<OfflineUpstream> {
  const reply = options.reply ?? "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Json = {};
      try {
        // A compressed request body is still a chat request.
        const raw = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
        body = obj(JSON.parse(raw.toString("utf8") || "{}"));
      } catch {
        /* not JSON: answered below as an unknown endpoint */
      }
      const path = req.url ?? "/";
      const model = typeof body.model === "string" ? body.model : "unknown";
      const stream = body.stream === true;
      const p = path.split("?")[0] ?? path;

      let out: { type: string; body: string } | undefined;
      if (p.endsWith("/messages/count_tokens")) {
        out = { type: "application/json", body: JSON.stringify({ input_tokens: 0 }) };
      } else if (req.method === "POST") {
        const kind = apiKindOf(path);
        if (kind === "anthropic-messages")
          out = anthropic(model, stream, answerFor(body, "anthropic", reply));
        else if (kind === "openai-chat")
          out = openaiChat(
            model,
            stream,
            answerFor(body, "chat", reply),
            obj(body.stream_options).include_usage === true,
          );
        else if (kind === "openai-responses")
          out = openaiResponses(model, stream, answerFor(body, "responses", reply));
      } else if (p.endsWith("/models")) {
        out = { type: "application/json", body: JSON.stringify({ object: "list", data: [] }) };
      }

      if (!out) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "not_found_error",
              message: `tokenwire --offline answers chat requests only; ${req.method} ${p} was not sent anywhere`,
            },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": out.type,
        "x-tokenwire-offline": "1",
        ...(out.type === "text/event-stream" ? { "cache-control": "no-cache" } : {}),
      });
      res.end(out.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
