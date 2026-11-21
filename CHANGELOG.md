# tokenwire

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
