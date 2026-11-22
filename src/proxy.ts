import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { urlToHttpOptions } from "node:url";
import { decodeBody } from "./decode.js";
import { apiKindOf, extract, parseSse, stripCredentials } from "./exchange.js";
import { OFFLINE_KEY, startOfflineUpstream, type OfflineUpstream } from "./offline.js";
import type { Exchange } from "./types.js";

export const DEFAULT_UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** Headers that belong to one hop and must not be forwarded. `host` is set to the upstream's. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface ProxyOptions {
  port?: number;
  host?: string;
  upstreams?: Record<string, string>;
  /** Called once per completed exchange, after the client has the whole response. */
  onExchange?: (exchange: Exchange) => void;
  /** Bodies larger than this are kept truncated in the record; the wire is unaffected. */
  maxRecordBytes?: number;
  /**
   * Answer chat requests locally instead of forwarding them (see offline.ts): the
   * request is recorded exactly, nothing leaves the machine. `reply` is the assistant
   * text every request gets back. Explicit `upstreams` are still forwarded.
   */
  offline?: { reply?: string };
}

export interface RunningProxy {
  port: number;
  url: string;
  upstreams: Record<string, string>;
  /** Environment variables that point an SDK at this proxy. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/**
 * A byte-faithful proxy. The request goes upstream exactly as received (minus
 * hop-by-hop headers), the response comes back exactly as the upstream sent it —
 * still compressed, still chunked, still streaming. A copy of each body is
 * decoded on the side for the record. Nothing here can change what the model
 * sees or what the client receives.
 */
export async function startProxy(options: ProxyOptions = {}): Promise<RunningProxy> {
  for (const [name, url] of Object.entries(options.upstreams ?? {})) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))
      throw new Error(`upstream "${name}" must be an http:// or https:// URL, got "${url}"`);
  }
  let offline: OfflineUpstream | undefined;
  if (options.offline) offline = await startOfflineUpstream(options.offline);
  const defaults = offline
    ? Object.fromEntries(Object.keys(DEFAULT_UPSTREAMS).map((k) => [k, offline!.url]))
    : DEFAULT_UPSTREAMS;
  const upstreams = { ...defaults, ...(options.upstreams ?? {}) };
  const offlineNames = new Set(
    offline ? Object.keys(upstreams).filter((k) => upstreams[k] === offline!.url) : [],
  );
  const maxRecord = options.maxRecordBytes ?? 8 * 1024 * 1024;

  const server = http.createServer((req, res) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://tokenwire.invalid");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("tokenwire: could not parse the request target.\n");
      return;
    }
    const [name, ...rest] = url.pathname.split("/").filter(Boolean);
    // Own properties only: "/constructor/…" or "/__proto__/…" must not reach Object.prototype.
    const base = name && Object.hasOwn(upstreams, name) ? upstreams[name] : undefined;
    if (!name || typeof base !== "string") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `tokenwire: no upstream named "${name ?? ""}". Known: ${Object.keys(upstreams).join(", ")}. ` +
          `Point your SDK at ${`http://127.0.0.1:${(server.address() as { port: number }).port}/<name>`}.\n`,
      );
      return;
    }
    // What the client asked for, after the upstream name. This is what the record keeps.
    const path = `/${rest.join("/")}${url.search}`;
    const upstreamBase = new URL(base);
    const target = upstreamTarget(upstreamBase, `/${rest.join("/")}`, url.search);
    // The client chooses the path, never the host: whatever the path holds, the request
    // goes to the upstream the user configured, or nowhere.
    if (target.origin !== upstreamBase.origin) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end(`tokenwire: that path does not stay on upstream "${name}".\n`);
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = target.host;

    const client = target.protocol === "https:" ? https : http;
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    let upstreamRes: http.IncomingMessage | undefined;
    const resChunks: Buffer[] = [];
    let resBytes = 0;
    let recorded = false;
    let clientGone = false;

    /**
     * One record per exchange, however it ends: the response completed, the upstream
     * failed (before or during the response), or the client went away.
     */
    const record = (error?: string) => {
      if (recorded) return;
      recorded = true;
      if (!options.onExchange) return;
      const kind = apiKindOf(path);
      const reqTruncated = reqBytes > maxRecord;
      const requestJson = reqTruncated
        ? `[truncated: ${reqBytes} bytes]`
        : parseJson(
            decodeBody(Buffer.concat(reqChunks), req.headers["content-encoding"]).toString("utf8"),
          );
      const model =
        requestJson && typeof requestJson === "object" && "model" in requestJson
          ? String((requestJson as { model: unknown }).model)
          : undefined;
      const request = {
        headers: stripCredentials(req.headers),
        body: requestJson,
        bytes: reqBytes,
        ...(reqTruncated ? { truncated: true as const } : {}),
      };
      const base = {
        id: randomUUID(),
        at: new Date(started).toISOString(),
        upstream: name,
        method: req.method ?? "GET",
        path,
        kind,
        ...(model ? { model } : {}),
      };
      const none = extract("other", undefined, false).usage;

      if (!upstreamRes) {
        // No response at all: the upstream was unreachable, or the client left first.
        options.onExchange({
          ...base,
          stream: false,
          request,
          response: {
            // What the client was sent: 502 when the upstream was unreachable, 0 when
            // the client left before any response.
            status: res.headersSent ? res.statusCode : 0,
            headers: {},
            body: undefined,
            bytes: 0,
            truncated: false,
            usage: none,
            toolCalls: [],
            text: "",
          },
          durationMs: Date.now() - started,
          error: error ?? "no response",
        });
        return;
      }

      const truncated = resBytes > maxRecord;
      const contentType = String(upstreamRes.headers["content-type"] ?? "");
      const stream = contentType.includes("text/event-stream");
      let responseBody: unknown;
      if (truncated) responseBody = `[truncated: ${resBytes} bytes]`;
      else {
        let raw: Buffer;
        try {
          raw = decodeBody(Buffer.concat(resChunks), upstreamRes.headers["content-encoding"]);
        } catch {
          // A compressed body cut off mid-stream may not decode; keep what can be said.
          raw = Buffer.alloc(0);
        }
        responseBody = stream ? parseSse(raw.toString("utf8")) : parseJson(raw.toString("utf8"));
      }
      const isOffline = offlineNames.has(name);
      const extracted = truncated
        ? { usage: none, toolCalls: [], text: "" }
        : extract(kind, responseBody, stream);
      const { toolCalls, text } = extracted;
      // The stand-in reports zero usage; that is not a measurement and must not read as one.
      const usage = isOffline ? none : extracted.usage;
      options.onExchange({
        ...base,
        stream,
        request,
        response: {
          status: upstreamRes.statusCode ?? 0,
          headers: stripCredentials(upstreamRes.headers),
          body: responseBody,
          bytes: resBytes,
          truncated,
          usage,
          toolCalls,
          text,
        },
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
        ...(isOffline ? { offline: true as const } : {}),
      });
    };

    const upstreamReq = client.request(
      {
        // Scheme, host, port and any credentials from the configured upstream; only the
        // path from the client.
        ...urlToHttpOptions(upstreamBase),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (r) => {
        upstreamRes = r;
        const resHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(r.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k)) continue;
          resHeaders[k] = v;
        }
        res.writeHead(r.statusCode ?? 502, resHeaders);
        r.on("data", (chunk: Buffer) => {
          resBytes += chunk.length;
          if (resBytes <= maxRecord) resChunks.push(chunk);
        });
        r.pipe(res);
        r.on("end", () => record());
        // The upstream went away mid-response. The client must not be left waiting for
        // bytes that will never come, and must not receive a response that looks whole:
        // the connection is cut, as the upstream's was.
        r.on("error", (err) => {
          res.destroy();
          record(`upstream "${name}" failed mid-response: ${err.message}`);
        });
      },
    );

    upstreamReq.on("error", (err) => {
      if (clientGone) {
        record("the client closed the connection before the response finished");
        return;
      }
      if (upstreamRes) {
        // Headers (and maybe some of the body) are already with the client.
        res.destroy();
        record(`upstream "${name}" failed mid-response: ${err.message}`);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`tokenwire: upstream "${name}" (${target.origin}) is unreachable: ${err.message}\n`);
      record(err.message);
    });

    // The client went away before it had the whole response: stop the upstream request
    // too, so it neither keeps generating (and billing) nor holds a socket open.
    res.on("close", () => {
      if (res.writableFinished) return;
      clientGone = true;
      upstreamReq.destroy();
      upstreamRes?.destroy();
      record("the client closed the connection before the response finished");
    });

    req.on("data", (chunk: Buffer) => {
      reqBytes += chunk.length;
      if (reqBytes <= maxRecord) reqChunks.push(chunk);
    });
    req.pipe(upstreamReq);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        port,
        url,
        upstreams,
        env: {
          ANTHROPIC_BASE_URL: `${url}/anthropic`,
          OPENAI_BASE_URL: `${url}/openai/v1`,
          // Offline: SDKs refuse to start without a key, and a real key has no business
          // here. A placeholder satisfies the first; replacing any real one means a
          // request that bypasses the proxy (a hard-coded base URL, a cloud SDK) fails
          // to authenticate instead of spending money.
          ...(offline
            ? {
                ANTHROPIC_API_KEY: OFFLINE_KEY,
                OPENAI_API_KEY: OFFLINE_KEY,
                AZURE_OPENAI_API_KEY: OFFLINE_KEY,
                ANTHROPIC_AUTH_TOKEN: OFFLINE_KEY,
              }
            : {}),
        },
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => {
              if (offline)
                offline.close().then(
                  () => r(),
                  () => r(),
                );
              else r();
            });
          }),
      });
    });
  });
}

/**
 * Where a request goes: the configured upstream's scheme, host and port, its path as a
 * prefix (`https://x.openai.azure.com/openai` + `/v1/chat/completions`), and its query
 * merged with the client's (`?api-version=…`). The client's query is passed on as sent
 * and wins over an upstream parameter of the same name.
 */
function upstreamTarget(upstream: URL, clientPath: string, clientSearch: string): URL {
  const prefix = upstream.pathname.replace(/\/+$/, "");
  const client = new URLSearchParams(clientSearch);
  const kept = new URLSearchParams(
    [...upstream.searchParams].filter(([k]) => !client.has(k)),
  ).toString();
  const own = clientSearch.replace(/^\?/, "");
  const query = [kept, own].filter(Boolean).join("&");
  return new URL(`${prefix}${clientPath}${query ? `?${query}` : ""}`, upstream.origin);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
