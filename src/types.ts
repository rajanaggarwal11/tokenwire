/** Which wire format a request used. Decided from the path, not the upstream name. */
export type ApiKind = "anthropic-messages" | "openai-chat" | "openai-responses" | "other";

export interface Usage {
  /** Input tokens the provider billed, cache reads included. */
  input: number;
  output: number;
  /** Anthropic: cache_read_input_tokens. OpenAI: input_tokens_details.cached_tokens / prompt_tokens_details.cached_tokens. */
  cacheRead: number;
  /** Anthropic only: cache_creation_input_tokens. */
  cacheWrite: number;
  /** Where the numbers came from. "provider" is exact; "none" means the response carried no usage. */
  source: "provider" | "none";
}

export interface ToolCall {
  name: string;
  /** The JSON arguments as the model produced them, when the response carried them whole. */
  input?: unknown;
}

/** One request/response pair through the proxy, credentials removed. */
export interface Exchange {
  id: string;
  /** ISO timestamp of the request. */
  at: string;
  upstream: string;
  method: string;
  /**
   * Path and query as the client sent them, after the upstream name, e.g.
   * /v1/messages?beta=true. A path prefix or query on the `--upstream` URL is added
   * on the way out and is not part of this.
   */
  path: string;
  kind: ApiKind;
  model?: string;
  stream: boolean;
  request: {
    headers: Record<string, string>;
    /** Parsed JSON body, or the raw text when it was not JSON. */
    body: unknown;
    bytes: number;
    /**
     * The body was larger than the record keeps (8 MB by default): `body` holds a
     * placeholder, and the request is left out of linting, with a warning. The wire
     * was unaffected. Absent in records made before 0.2.0.
     */
    truncated?: boolean;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    /** Parsed JSON for a JSON body; for SSE, the list of parsed event payloads. */
    body: unknown;
    bytes: number;
    truncated: boolean;
    usage: Usage;
    toolCalls: ToolCall[];
    /** The assistant's text output, concatenated. */
    text: string;
  };
  durationMs: number;
  error?: string;
  /**
   * Captured with `--offline`: the request is exactly what the app built, but the
   * response came from tokenwire's stand-in, not the provider. Usage is "none".
   */
  offline?: true;
}
