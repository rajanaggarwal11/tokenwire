# tokenwire

## 0.2.0

### Minor Changes

- [#22](https://github.com/rajanaggarwal11/tokenwire/pull/22) [`29c4b51`](https://github.com/rajanaggarwal11/tokenwire/commit/29c4b51e53c22923d87aca994a6d121d032b6504) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - CI mode — size-limit for prompts. `wrap --offline` records exactly what your app sends without sending it: chat requests are answered locally in the format each SDK expects (Anthropic Messages, OpenAI Chat Completions and Responses, streaming or not; forced tools and structured output get schema-shaped answers), and API keys in the environment are replaced with a placeholder, so CI needs no key and costs nothing. `snapshot` writes a small baseline to commit (system prompt and tool definitions with their text; for the conversation, only kinds and token counts — no text, no hashes). `diff` compares a run against it: input tokens per run by section, tools added, removed and changed, where a request stops repeating the earlier request it continues (the prompt-cache break, to the character), timestamps or ids in the prompt that change every run, and the cost of the change. Exit 1 on a new cache break or over `--max-increase`; `--format markdown` for a PR comment, `--format json` for machines.

### Patch Changes

- [#24](https://github.com/rajanaggarwal11/tokenwire/pull/24) [`9d0bf4c`](https://github.com/rajanaggarwal11/tokenwire/commit/9d0bf4c60ca2177a5f1e5a592e8e5745841fab49) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - Fixes for the proxy, the CLI and snapshots.

  - The proxy no longer crashes on a path named after an `Object.prototype` key (`GET /constructor/x` is a 404) or on a request target it cannot parse (400).
  - An upstream that fails mid-response now ends the client's connection at once instead of leaving it waiting; a client that disconnects early now cancels the upstream request, so a model call nobody is waiting for stops generating. Both are recorded with an `error`.
  - An unknown command (`tokenwire chek`) exits 2 and suggests the closest one, preferring a prefix (`snap` → `snapshot`). So does a command after `--` without `wrap` (`tokenwire -- node app.js`). Before, both started a proxy that never exited and emptied `tokenwire.session.jsonl`. The session file is now emptied only once the proxy is up, so a bad option never costs you the last session.
  - `wrap` passes SIGTERM and SIGHUP on to the command, and exits 128 + the signal number when the command is killed by one. Ctrl-C is not passed on: the terminal already sends it to the command, and a second one means "force quit" to many tools.
  - `--upstream` keeps a path prefix and a query on the URL you give it: `https://my-resource.openai.azure.com/openai?api-version=preview` used to lose both. The client's query wins on a clash. An upstream that is not an http(s) URL is refused at start. **Check your `--upstream` values when upgrading:** if you worked around the old behaviour by also putting the prefix in your SDK's base URL (`--upstream openai=http://localhost:4000/v1` with the SDK pointed at `…/openai/v1`), requests now go to `/v1/v1/…`. Keep the prefix in one place.
  - A client that disconnects before any response is recorded with status 0, not a 502 that was never sent.
  - A request body over the 8 MB the record keeps is marked `truncated` and named in a warning by `report`, `check`, `snapshot` and `diff`, instead of disappearing from the report.
  - `snapshot` writes anything `secret-in-context` would flag in the system prompt or tool definitions as `[redacted: …]`. Token counts are unchanged. A change inside a secret is reported at its placeholder ("changed inside [redacted: an sk- API key]"), and a baseline committed before this release is redacted as it is read.
  - The offline stand-in bounds the whole value it builds from a schema (10,000 values), so nested `minItems` can no longer make it build millions of values or run out of memory.
  - Live mode parses each request once instead of re-parsing the whole session on every request. The rules still run over every request each time.
  - `diff --price` says when its dollar figures rest on o200k tokenizer estimates.
  - The package exports the same API as 0.1.1; CI-mode internals added during this cycle are no longer exported.

## 0.1.1

### Patch Changes

- [#11](https://github.com/rajanaggarwal11/tokenwire/pull/11) [`900118e`](https://github.com/rajanaggarwal11/tokenwire/commit/900118eac5ba23c7b9bd421b231010e8a42ed32e) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - `--budget`, `--window` and `--max-growth` read a `k` or `m` suffix as a multiplier: `--budget 1.5k` is 1,500 tokens, not 1.5. A value that is not a number now says what it expects.

- [#21](https://github.com/rajanaggarwal11/tokenwire/pull/21) [`fb9b065`](https://github.com/rajanaggarwal11/tokenwire/commit/fb9b065df157b62a66f1dac809f36207a9683bef) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - Renamed from `ctxlint` to `tokenwire` before the first npm release, so it can't be confused with the unrelated `@yawlabs/ctxlint`. The command, the package and the default session file (`tokenwire.session.jsonl`) all use the new name.

## 0.1.0

### Minor Changes

- [`28223f4`](https://github.com/rajanaggarwal11/tokenwire/commit/28223f45967a3d1b001c6aefcf075b0dd209fe12) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - First release. A byte-faithful local proxy for Anthropic and OpenAI, a record that never
  contains a credential, and ten rules over what an app sends the model: budget, growth,
  duplicate-content, stale-tool-results, unused-tools, no-cache, cache-miss (with the character
  that broke the cache), oversized-system, secret-in-context, injection-in-tool-result.
  `tokenwire wrap -- <command>`, a live proxy mode, `report`, `check` with exit codes 0/1/2,
  `--json`, `--sections`. Works with anything that honours `ANTHROPIC_BASE_URL` /
  `OPENAI_BASE_URL` — every official SDK, Claude Code, Codex CLI.
