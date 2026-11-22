# CI mode: the details

The [README](../README.md#in-ci-size-limit-for-prompts) covers the three steps: record with `wrap --offline`, commit a baseline with `snapshot`, and run `diff` on every PR. This page is the exact behaviour behind them.

## How `--offline` answers

`--offline` answers every chat request locally, in the wire format the client asked for: Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, streamed or whole. The request is recorded exactly as the app built it; nothing is sent to a provider.

The answer is shaped to what the request demands, so the SDK's own parsing succeeds:

- **A forced tool** (`tool_choice` naming one, `any` or `required`) gets a call to that tool, with arguments built from its input schema.
- **Structured output** (`output_config.format` or `output_format` on Anthropic, `response_format` on Chat Completions, `text.format` on Responses, with a JSON schema) gets JSON built from that schema. `json_object` gets `{}`.
- **Anything else** gets an empty assistant turn that ends the conversation. `--reply "…"` sets its text.

Values built from a schema honour `const`, `enum`, `default`, `minimum`, `minLength`, `minItems`, common `format`s and local `$ref`s. They are bounded whatever the schema asks: at most 64 characters per string, 64 items per array, and 10,000 values in the whole answer. A schema that demands more than that (deeply nested `minItems`, for example) gets a smaller answer that may not satisfy it.

Because a plain request gets an answer that ends the turn, an agent loop stops after its first request: the system prompt, the tool definitions and the opening message. That is where most of the bill and nearly every cache break come from. To cover a multi-request loop, have the scenario make each request itself.

`count_tokens` and model listings get empty answers. Any other request is refused with a 404 and is not sent anywhere. An upstream you name with `--upstream` is still forwarded.

## What counts as a cache break

Prompt caches key on an exact prefix: what a conversation sent before must reappear unchanged, with only new messages after it. `diff` looks for the first place where a request stops repeating the earlier request it continues.

A request _continues_ an earlier one when it has the same API and model, repeats that conversation, and carries the earlier request's answer after it. Only then is it expected to repeat the prefix. A sub-agent with its own system prompt, a parallel conversation, the next question after shared few-shot examples, or a Responses API call that sends only new items is not a continuation and never counts as a break. A request for another model in between does not hide one.

For a break in the system prompt or a tool definition, the report quotes the character where the text changed. A break in the conversation is located (which message) but never quoted. A change that is only a timestamp, a date or an id is called out as a value that changes on every run.

## When `diff` fails and when it warns

It fails (exit `1`) when:

- the change introduces a cache break at a place where the baseline had none, or
- input tokens per run grow past `--max-increase` (`10%` or `2k`).

It warns when:

- one side was counted by the provider and the other with a tokenizer estimate,
- the two sides use different models, or
- either side is missing a request that was too large to record (see below).

A run that recorded no chat requests at all is an error (exit `2`), not a saving.

## What a snapshot contains

For each request: its API, model and total input tokens, and its sections in order (system prompt, tool definitions, messages) with their token counts. Only the static prefix, the system prompt and tool definitions at the start of the request, keeps its text and a SHA-256 hash; that text lives in your code anyway. Conversation sections keep their kind, tool name and token count only: no text and no hash, since a hash of a short message can be reversed by guessing.

Anything the `secret-in-context` rule would flag (API keys, tokens, private keys, database URLs with a password) is replaced with `[redacted: …]` before it is written. Token counts and hashes are of the text as sent, so a redacted snapshot diffs cleanly against a live run.

Cache breaks within the run are computed when the snapshot is taken and stored with it, because the committed file no longer has the conversation hashes needed to find them again.

## Counts and money

Offline, nothing reports usage, so every count is an estimate from the o200k tokenizer. That is OpenAI's tokenizer; Claude's tokenizer counts the same text differently, so for Claude models treat the numbers as close, not exact. Recorded against a provider, totals come from its `usage` and are exact; per-section numbers are estimates scaled to that total.

Dollar figures appear only when you pass `--price` (USD per million input tokens, your rate), and they inherit the same estimate. Images and documents are counted as placeholders, not their real cost.

## Requests too large to record

The proxy forwards every byte, but the record keeps at most 8 MB of each body. A larger request (usually base64 images or PDFs) is marked `"truncated": true` in the record and left out of linting and snapshots. `report`, `check`, `snapshot` and `diff` name it in a warning, so a missing request is never mistaken for a smaller one.
