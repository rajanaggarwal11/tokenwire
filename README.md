# tokenwire

**See exactly what your app sends the model, and lint it.** A local proxy for Anthropic and OpenAI traffic that flags unused tools, prompt-cache breaks down to the character, secrets, and injection in tool results. Never modifies a request.

[![CI](https://github.com/rajanaggarwal11/tokenwire/actions/workflows/ci.yml/badge.svg)](https://github.com/rajanaggarwal11/tokenwire/actions/workflows/ci.yml) [![CodeQL](https://github.com/rajanaggarwal11/tokenwire/actions/workflows/codeql.yml/badge.svg)](https://github.com/rajanaggarwal11/tokenwire/actions/workflows/codeql.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

```bash
npx tokenwire wrap -- claude -p "summarise this repo"    # any command that honours ANTHROPIC_BASE_URL / OPENAI_BASE_URL
npx tokenwire wrap -- node agent.js
npx tokenwire                                            # a proxy that reports live; point your app at it
```

The record never contains a credential, and stays on your machine.

Here is Claude Code doing a small task (read three files, grep, `git log`), through the proxy:

```
$ tokenwire wrap -- claude -p "Read src/proxy.ts, src/exchange.ts and src/context.ts …" --model haiku
tokenwire · proxy on http://127.0.0.1:54580 · ANTHROPIC_BASE_URL and OPENAI_BASE_URL set for: claude -p … --model haiku
  #1 HEAD anthropic/api/hello  200 not a chat request 0.3s
  #2 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 966 in · 15 out 1.1s
  #3 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 35,760 in (32,452 cached) · 396 out 4.2s
  #4 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 46,557 in (35,750 cached) · 92 out 1.9s
  #5 POST anthropic/v1/messages claude-haiku-4-5-20251001 200 46,743 in (46,549 cached) · 522 out 6.0s

tokenwire · 4 requests · claude-haiku-4-5-20251001 · tokenwire.session.jsonl

 turn      input   cache r/w   output   system   tools   history  model
    1        966           —       15      87%      0%       13%  claude-haiku-4-5-20251001
    2     35,760    32,452 r      396      19%     73%        8%  claude-haiku-4-5-20251001
    3     46,557    35,750 r       92      15%     57%       29%  claude-haiku-4-5-20251001
    4     46,743    46,549 r      522      15%     56%       29%  claude-haiku-4-5-20251001

tools: 29 defined, 26,244 tokens on turn 4 · largest: Bash 3,218 · DesignSync 2,455 · Monitor 2,290 · Agent 2,256 · Workflow 1,497

 warn  unused-tools
  ! 27 of 29 tool definitions were never called in 4 turns — 22,302 tokens on every turn that carries them
      Agent, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor, NotebookEdit, PushNotification, … (15 more)
────────────────────────────────────────────────
1 finding: 1 warning · 89,208 tokens at stake
```

Every turn after the warm-up is 56–73% tool definitions — 29 of them, 27 of which this task never touched. Nothing here is a bug in Claude Code — it caches all of it and pays a tenth of the price — but nobody had a way to see it before.

## What it finds

| Rule                       | Severity | What it catches                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret-in-context`        | error    | API keys, tokens, private keys, database passwords sent to the model, and where — system prompt, message, or which tool's result. Never repeats the secret.                                                                                                                                               |
| `injection-in-tool-result` | error    | Tool results and retrieved documents that tell the model to ignore its instructions, hide something from the user, send credentials, or carry invisible characters or fake role tags. This is where injection actually arrives. Reported once per poisoned result, not once per turn it stays in context. |
| `budget`                   | warn     | Input tokens per request over `--budget`.                                                                                                                                                                                                                                                                 |
| `growth`                   | warn     | Over 6+ turns, the context grows more than `--max-growth` per turn (median, so a warm-up call does not distort it) and never shrinks — and the turn at which the window fills.                                                                                                                            |
| `duplicate-content`        | warn     | The same 200+-token block twice in one request: a file pasted twice, a tool result echoed into a message, the system prompt repeated in the first user turn.                                                                                                                                              |
| `stale-tool-results`       | warn     | A 2,000+-token tool result from 6+ messages back still carried in full.                                                                                                                                                                                                                                   |
| `unused-tools`             | warn     | Tools defined on 3+ turns that the model never called, and what their definitions cost on every turn.                                                                                                                                                                                                     |
| `no-cache`                 | warn     | Anthropic: a 4,096+-token prefix sent byte-identical across turns with no `cache_control` — and what that cost.                                                                                                                                                                                           |
| `cache-miss`               | warn     | Anthropic: `cache_control` is on and `cache_read_input_tokens` is 0 — names the section and the first character where the prefix changed (`Current time: 14:02` → `14:03`).                                                                                                                               |
| `oversized-system`         | info     | On the latest request, the system prompt is 60%+ of the input and 2,000+ tokens.                                                                                                                                                                                                                          |

`tokenwire --list-rules` prints the same. Money rules are warnings; security rules are errors; `--strict` makes warnings fail the build.

## Anatomy of a Claude Code turn

`tokenwire report --sections` lists every section of the last request, largest first. The same session as above (Claude Code 2.1.270, `claude-haiku-4-5`, 2026-09-14):

```
sections of turn 4, largest first
    6,740   14%  system  [cache_control]
    3,478    7%  result Read (msg 3)
    3,218    7%  tool Bash
    2,569    5%  result Read (msg 3)
    2,455    5%  tool DesignSync
    2,431    5%  result Read (msg 3)
    2,290    5%  tool Monitor
    2,256    5%  tool Agent
    1,805    4%  user (msg 1)
    1,497    3%  tool Workflow
       …
```

The system prompt is 6,740 tokens and carries `cache_control`; the 29 tool definitions add 26,244; the three files the task read are 8,478 across three `Read` results. 46,549 of the 46,743 input tokens on turn 4 were served from cache.

## How it works

```
your app ──(ANTHROPIC_BASE_URL / OPENAI_BASE_URL)──▶ tokenwire :port ──▶ api.anthropic.com / api.openai.com
                                                          │
                                                          ├─ records request + response usage (credentials stripped)
                                                          ├─ lints after every request, prints what is new
                                                          └─ tokenwire.session.jsonl
```

- **The wire is untouched.** Requests go upstream exactly as received (minus hop-by-hop headers), responses come back exactly as the upstream sent them — still compressed, still chunked, still streaming. A copy of each body is decoded on the side for the record. Tests compare hashes of what was sent with what arrived.
- **Three formats, one model.** Anthropic Messages, OpenAI Chat Completions and OpenAI Responses parse to the same ordered list of sections — system, tool definitions, user, assistant, tool results — each with its turn, a hash, and its `cache_control` marker.
- **Numbers.** Totals come from the provider's own `usage` and are exact. Per-section numbers are tokenizer estimates scaled so they sum to that exact total; when a response carried no usage (an OpenAI stream without `stream_options.include_usage`), the report says `≈` and never injects the option to get it.
- **The record.** One exchange per line in `tokenwire.session.jsonl`, local, credentials replaced with `[stripped]` before the line is written. `--no-record` keeps nothing. The record does hold the content of your requests — that is what gets linted.

## In CI: size-limit for prompts

Every PR that touches a prompt or a tool changes what each request costs, and whether the prompt cache still hits. Nobody sees it until the bill. tokenwire puts it in the PR:

```
tokenwire diff  467 → 1,151 input tokens per run  +684 (+146.5%)

  system prompt                     60 →        90       +30
  tool definitions (3 → 4)         139 →       451      +312
  first message                     12 →        12         0
    + search_knowledge_base +312

✗ cache: request 2 stops repeating request 1 at the system prompt, char 221: "39.785" → "41.328"
  (a timestamp or id rendered in on every request) — 553 tokens from
  there on can't be served from cache
  cost +$41.04/day at 20,000 runs/day, $3/MTok

✗ this change breaks prompt caching at the system prompt
```

That is a real run: a support agent built on the Anthropic SDK, and a change that adds one tool and puts the current time in the system prompt.

**1. Record without sending.** `--offline` answers every chat request locally, in the format the SDK expects (Anthropic Messages, OpenAI Chat Completions and Responses, streaming or not). The request your app builds is recorded exactly, and the run is free and the same every time. Any API key in the environment is replaced with a placeholder, so the SDK starts without a real one — and a request that bypasses tokenwire fails to authenticate instead of spending money. Requests reach tokenwire through `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, which the official SDKs read; an app with a hard-coded base URL, or one going through Bedrock or Vertex, is not captured.

```bash
npx tokenwire wrap --offline -- node test/agent-scenario.js
```

A request that forces a tool call or asks for structured output gets an answer built from its schema; anything else gets an empty assistant turn (`--reply "…"` sets its text), so an agent loop stops after its first request: the system prompt, the tool definitions and the opening message, which is where most of the bill and nearly every cache break come from. Details: [docs/ci.md](./docs/ci.md#how---offline-answers).

**2. Commit a baseline.** `npx tokenwire snapshot` writes `tokenwire.snapshot.json`: the text and a hash of the system prompt and tool definitions at the start of each request — the parts that live in your code — and, for everything after them, only each section's kind and token count. No conversation text and no conversation hash is written: not what users typed, not what tools returned, not a system message inserted mid-conversation. Anything `secret-in-context` would flag in the system prompt or a tool definition is written as `[redacted: …]`; token counts are of what was actually sent.

**3. Diff every PR against it.**

```bash
npx tokenwire diff tokenwire.snapshot.json --max-increase 10% --price 3 --runs-per-day 20000
```

| It reports           |                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input tokens per run | base → this change, per section: system prompt, tool definitions, first message                                                                                                                                                                                                 |
| Tools                | added, removed and changed, with what each costs                                                                                                                                                                                                                                |
| Prompt caching       | where a request stops repeating the earlier request it continues — the section, the character (for your system prompt and tools; conversation text is never quoted), and the tokens that can no longer be cached; and a timestamp or id in the prompt that changes on every run |
| Cost                 | only with `--price` (your USD per million input tokens): per run, or per day and month with `--runs-per-day`. Offline counts are estimates from the o200k tokenizer, which is OpenAI's, including for Claude models                                                             |

How a request is matched to the one it continues, and what does not count as a cache break: [docs/ci.md](./docs/ci.md#what-counts-as-a-cache-break).

It fails (exit `1`) when the change introduces a cache break at a place where the baseline had none, or grows input tokens past `--max-increase` (`10%` or `2k`). It warns when the two sides were counted differently (provider usage on one, a tokenizer estimate on the other), use different models, or either is missing a request too large to record. Counts for images and documents are placeholders, not their real cost. `--format markdown` writes a PR comment; `--format json` a stable shape (`version: 1`). To accept a change, re-record and run `npx tokenwire snapshot` in the same PR, so the new baseline is reviewed with the code that caused it.

[tokenwire-action](https://github.com/rajanaggarwal11/tokenwire-action) does all three in one step and keeps a single comment on the PR up to date.

### Linting a recorded session

```yaml
- run: npx tokenwire wrap --session agent.jsonl -- node test/agent-scenario.js
- run: npx tokenwire check agent.jsonl --budget 60k --strict
```

Exit codes are stable: `0` nothing to report · `1` findings remain (errors, or warnings under `--strict`) · `2` could not run. `--json` emits a stable shape (`version: 1`) with per-turn totals, section breakdowns, and findings.

## Options

```
tokenwire wrap [options] -- <command> [args…]   Run a command through the proxy, then report
tokenwire [options]                              Start the proxy and report live (Ctrl-C to finish)
tokenwire report [session] [--sections]          Report on a recorded session (default: tokenwire.session.jsonl)
tokenwire check [session]                        Lint a recorded session for CI — exit 0/1/2
tokenwire snapshot [session] [-o file]           Save what a session sends, small enough to commit
tokenwire diff <base> [head]                     Compare snapshots or sessions — exit 0/1/2

--port <n>              --upstream <name=url>     --session <file>     --no-record     --append
--offline               --reply <text>
--max-increase <n|n%>   --price <usd/MTok>        --runs-per-day <n>   --format text|markdown|json
--budget <n>            --max-growth <pct>        --window <n>
--only <ids>            --ignore <ids>            --strict             --json          --sections
```

Any other first word is an error (exit `2`) that names the closest command, and so is a command after `--` without `wrap`.

`--upstream` adds or replaces a target: `--upstream openai=https://my-gateway.internal` keeps the `OPENAI_BASE_URL` the proxy prints and sends the traffic wherever you say. A path and a query on that URL are kept: the path is put in front of the client's, and the query is merged with the client's (the client's wins on a clash). For Azure OpenAI, `--upstream "openai=https://my-resource.openai.azure.com/openai?api-version=preview"` sends `/openai/v1/chat/completions?api-version=preview`; for a gateway that serves each provider under its own path, `--upstream anthropic=http://localhost:4000/anthropic`.

`wrap` passes SIGTERM and SIGHUP on to the command. Ctrl-C in a terminal already reaches the command, so tokenwire does not send it a second time; it waits for the command to exit and then reports. A command killed by a signal exits `128` + the signal number.

## As a library

```ts
import { startProxy, lintExchanges, contextOf } from "tokenwire";

const proxy = await startProxy({ onExchange: (x) => exchanges.push(x) });
// … run your app with proxy.env …
const { findings, turns } = lintExchanges(exchanges, { budget: 40_000 });
```

`contextOf(exchange)` gives you the section model for your own analysis; `ALL_RULES` is the list, and a `Rule` is a small interface.

## Works with

Anything that honours `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`: the official SDKs in every language, Claude Code, Codex CLI, and most frameworks built on those SDKs. A client that pins its base URL, or refuses `http://` for localhost, is out of scope.

## Why not Langfuse, LiteLLM, Helicone or promptfoo?

They are good at what they do, and you may want one of them as well. Langfuse and Helicone are observability platforms, hosted or self-hosted, that trace and store production LLM traffic over time. LiteLLM is a gateway: one API in front of many providers, with routing, keys and spend limits. promptfoo is an eval and red-teaming suite that scores model outputs against test cases.

tokenwire is narrower. It is a local pass-through that never modifies a request, needs no account and no server, and keeps its record in a file next to your code. Its job is the request itself: what each one carries, section by section, and what in it is waste or risk. In CI it diffs what each PR adds to every request (tokens per section, tools added or changed, the exact character that breaks the prompt cache) offline, with no API key.

## Design notes

**Why a proxy and not an SDK plugin.** There is one SDK plugin per language per framework, and none for the tool you did not write. There is one wire.

**Why it never modifies a request.** The moment a proxy changes what the model sees, its report is about something other than your app. Estimates are labelled ≈ rather than fixed by injecting `stream_options`.

**Heuristics are labelled.** `unused-tools` will flag a tool your next task needs; `growth` is a projection from a median. They exist to make a person look, with the number in hand.

**What it does not do.** No PII detection (a regex is worse than nothing there), no judgement of whether the model _followed_ an instruction (that needs a model), and no built-in prices: everything is counted in tokens, and `diff` shows dollars only when you pass `--price` with your own rate (prices change; tokens do not).

**Requests over 8 MB.** The wire is unaffected, but the record keeps at most 8 MB of each body. A larger request (usually base64 images or PDFs) is marked `truncated` in the record, left out of linting, and named in a warning by `report`, `check`, `snapshot` and `diff`.

## Requirements

Node 22.13 or newer.

## Working with me

**Want this run on your agent?** I review what production agents send — cost, caching, the paths injection takes — and hand back the numbers with the fixes. Write to me: [aggarwal11.rajan05@gmail.com](mailto:aggarwal11.rajan05@gmail.com).

## License

[MIT](./LICENSE) © Rajan Aggarwal
