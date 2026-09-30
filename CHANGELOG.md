# Changelog

## 0.9.0 — 2026-10-01

Minor bump, not a patch: this release adds four providers, a second binary (`chatgpt`) and
live voice on top of v0.8.0 — new surface, not fixes.

### New models

| model | id | aliases | notes |
|---|---|---|---|
| GPT-6.1 Sol | `gpt-6.1-sol` | `gpt` `codex` `sol` `gpt61sol` `gpt61` `sol61` | Codex catalog lists it only from client 0.159.0 (`CODEX_CLIENT_VERSION_FLOOR` 0.155.0 → 0.159.0); heads the Sol slot in the harness order. No list price yet. |
| Claude Opus 5.5 | `claude-opus-5-5` | `opus` `opus55` | $4 / $20 per MTok, cache hits 0.05x; 1M context. Leads the Opus block. |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | `sonnet` `sonnet55` | $2 / $10 per MTok; 1M context. Labelled `(dumb - do not use)` in the roster like every Sonnet. |
| Gemini 3.8 Flash | `gemini-3.8-flash` | `gemini` `gemini38` `flash` | In the offline fallback, so a fresh install resolves `gemini` to 3.8 without a refresh. |
| GPT-6 Sol / Luna | `gpt-6-sol` `gpt-6-luna` | `sol6` `luna` `luna6` | Registered with `none` effort on the wire. |

Behaviour change: `gpt`, `codex` and `sol` now mean `gpt-6.1-sol`; `astra`/`gpt6` stay on
`gpt-6-astra`, `sol6` on `gpt-6-sol`, `opus5`/`sonnet5` on the 5.0 models.

### Added
- Providers: xAI Grok, Gemini (API key, `gemini-key-*`), OpenCode Zen (`zen-*`), and the
  online ChatGPT-web route.
- `chatgpt` CLI (new bin) with its runtime under `src/chatgpt/`.
- Live voice: codex-live and gemini-live talk.
- Shared wire / Responses dialect, provider transport, capacity events, live-model reads.
- Tests run against a private, empty `APIPLAN_HOME` (bunfig preload), so a machine's model
  cache refresh no longer turns registry/roster pins red.
