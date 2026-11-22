---
"tokenwire": patch
---

Fixes for the proxy, the CLI and snapshots.

- The proxy no longer crashes on a path named after an `Object.prototype` key (`GET /constructor/x` is a 404) or on a request target it cannot parse (400).
- An upstream that fails mid-response now ends the client's connection at once instead of leaving it waiting; a client that disconnects early now cancels the upstream request, so a model call nobody is waiting for stops generating. Both are recorded with an `error`.
- An unknown command (`tokenwire chek`) exits 2 and suggests the closest one. Before, it started a proxy that never exited and emptied `tokenwire.session.jsonl`.
- `wrap` passes SIGINT and SIGTERM on to the command, and exits 128 + the signal number when the command is killed by one.
- A request body over the 8 MB the record keeps is marked `truncated` and named in a warning by `report`, `check`, `snapshot` and `diff`, instead of disappearing from the report.
- `snapshot` writes anything `secret-in-context` would flag in the system prompt or tool definitions as `[redacted: …]`. Token counts are unchanged.
- The offline stand-in bounds the whole value it builds from a schema (10,000 values), so nested `minItems` can no longer make it build millions of values or run out of memory.
- Live mode parses each request once instead of re-parsing the whole session on every request.
- `diff --price` says when its dollar figures rest on o200k tokenizer estimates.
- The package exports the same API as 0.1.1; CI-mode internals added during this cycle are no longer exported.
