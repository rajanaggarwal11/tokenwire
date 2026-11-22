---
"tokenwire": patch
---

Fixes for the proxy, the CLI and snapshots.

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
