# Composer predictions — how Codex does it, and how APIPlan does it

Researched and built 2026-10-10 by agent:APIPlan, on fire17's ask (WhatsApp ACC09BD5 15:15,
AC0A6436 15:19, ACD8E37F 15:31, AC164152 15:37): find Codex's new "Composer", map exactly how it
works (model, calls, inputs, outputs, which history, billing, knobs), and give us our own
`composer` CLI and API that work on any conversation, not only OpenAI's.

## What it is

OpenAI calls it **composer predictions**. "Composer" is the name of Codex's message box.

- Announced by @OpenAIDevs on 2026-10-09 18:22 UTC: "Now in beta: composer predictions in Codex
  for Pro users. Codex can now suggest your next message based on your conversation and how you
  talk to it." It runs in the Codex desktop app only, for local and SSH threads.
- After Codex finishes a turn, a full suggested next message can appear in the empty message box.
  Tab accepts it into the box. Nothing is sent automatically.
- Help article (help.openai.com/en/articles/20001601): personal ChatGPT Pro, adults, GPT-6 Astra
  and GPT-6.1 Sol only. It is on by default. You turn it off in Settings → General → Composer →
  "Show predictions". The article says predictions do not count toward usage during the beta.
- It is **not in the Codex CLI**. No stable release from 0.159.0 to 0.162.1 has it.

## How Codex does it (evidence, not inference, unless marked)

Sources: the shipped desktop app, ChatGPT.app 26.1007.21159 (appcast
`persistent.oaistatic.com/codex-app-prod/appcast.xml`, published 2026-10-08), unpacked from
`app.asar` and read from `.vite/build/main-39FdJ_vp.js` and `src-BJv5Mk7n.js`. The internal
codename is `cumberbatch`. Also github.com/openai/codex at 806d9732c9 (2026-10-10), and one live
read of the config endpoint for this account.

### 1. Server config: `GET chatgpt.com/backend-api/wham/predictions/config`

The app fetches this config and caches it for 5 minutes per user and account. It is validated
with this zod shape:
`{is_enabled: bool, unsupported_models?: string[], sample_rate?: 0..1, prompt: string,
prompt_version: string, prediction_reasoning_effort: string|null}`.

Live read for this account (acct-mac, plan `prolite`), 2026-10-10:

| field | value |
|---|---|
| is_enabled | `true` |
| prompt_version | `"5"` |
| prediction_reasoning_effort | `"high"` |
| sample_rate | `0.75` (also `live_sample_rate` 1.0 and `catch_up_sample_rate` 0.5, which the app does not read) |
| unsupported_models | gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-daybreak-blue-latest, gpt-daybreak-red-latest |
| prompt | see `FALLBACK_PROMPT` in `src/composer.ts` (verbatim copy of v5) |

**The prompt belongs to the server and has a version number.** OpenAI can change it without
shipping a new app. The CLI's own earlier copy was v1, labeled "Desktop FALLBACK_PROMPT,
fallback-1" in `codex-rs/tui/src/prompt_suggestions.rs` at e154f7b807. That copy was removed in
0.159.0.

### 2. When it runs (main bundle, `runPrediction` / `fge`)

- The setting "Show predictions" must be on, and the server config must say `is_enabled`.
- The app then rolls a die: if `Math.random() >= sample_rate`, it skips the turn. So 25% of
  turns get no prediction at all.
- It skips threads in plan mode (`plan_mode`), threads whose provider is not `openai`
  (`unsupported_provider`), and threads on a model in `unsupported_models`.
- It needs an app-server that supports `experimentalPredictionForkMode` (Codex 0.163 alpha or
  later: PR #51884).
- One prediction is kept per (host, thread, latest turn id). A new `turn/started` on the thread
  throws it away.

### 3. The calls (app-server JSON-RPC, then the Responses backend)

1. `thread/resume {threadId}`. Reads the parent thread's model, provider, service tier,
   reasoning effort and collaboration mode.
2. `thread/fork {threadId, experimentalPredictionMode: true, ephemeral: true, excludeTurns: true,
   threadSource: "composer_predictions"}`. This is a hidden, temporary fork. It inherits the
   parent's config, tools, environments and persisted history, "to maximize prompt-cache reuse"
   (protocol doc comment). It also turns on `features.reasoning_effort_override` for the fork.
3. `turn/start {threadId: fork, turnTrigger: "composer_predictions", input: [{type: "text",
   text: PROMPT + "\n\nReturn only JSON matching this schema: " + SCHEMA + "."}], effort}`.
   `effort` is the config's `prediction_reasoning_effort` (`high`), or the parent's effort if
   that is null. `outputSchema` is null, so the JSON is asked for in the prompt and not enforced
   by the API.
4. The app collects the agent message, waits for `turn/completed`, then calls
   `unsubscribeThread`. If the turn does not complete, it calls `turn/interrupt`. The CLI used a
   30-second timeout. In the app, the default for this helper is also 30 s (`Lq = 3e4`).
5. Result: `{suggestion: string|null}`. The app records model, effort, prompt_version,
   inputTokens and cachedInputTokens for its own telemetry.

On the wire, the fork's turn is an ordinary `POST /backend-api/codex/responses`. It has the same
model, the same instructions and tools, the full history, and one more user message. **The only
thing that marks it as a prediction** is the Codex turn metadata
(`core/src/responses_metadata.rs`). It is sent both as the header `x-codex-turn-metadata` and as
`client_metadata["x-codex-turn-metadata"]`, with `thread_source: "composer_predictions"`,
`turn_trigger: "composer_predictions"` and `forked_from_thread_id`.

The app-server also defines `thread/prediction/request` and `thread/prediction/updated` (PR
#49480). On main they still return `method_not_found("…not implemented yet")`, and the app does
not call them.

### 4. Which history it reads

Only the current thread: everything the fork inherits. That is the developer instructions, the
tools, earlier turns, and any memories or connected-app context that are already in the thread.
It does not look up other chats or memories on its own (help article; matches the code).

### 5. Billing

OpenAI says that during the beta, generating predictions does not count toward usage limits or
credits. Sending a message, including an accepted prediction, counts as normal.

**Unverified:** which signal the backend uses for that exemption. On the wire, the only
difference from a normal turn is the `composer_predictions` turn metadata above. We did not try
to measure it, on fire17's instruction (AC164152: "I didn't ask you to measure it, I trust them
that it doesn't cost us"). A small test could not measure it anyway: `x-codex-primary-used-percent`
and `/backend-api/codex/usage` report whole percents (0% weekly at the time).

## How APIPlan does it

`src/composer.ts`, `bin/composer.ts`, and two routes in `src/api.ts`. Tests:
`test/composer.test.ts` (24 tests, offline).

APIPlan does steps 1, 3 and 4 directly against the Responses backend, using the same OAuth token
APIPlan already uses (`~/.codex/auth.json`, read only):

1. It reads the live config (5-minute cache). If the config cannot be read, it falls back to the
   v5 copy, and `prompt_version` says `fallback-5`.
2. It turns any conversation into Responses input items, adds the app's exact prediction message,
   and sends `x-codex-turn-metadata` / `client_metadata` with `thread_source` and `turn_trigger`
   set to `composer_predictions` (`--no-tag` / `"tag": false` leaves them out). Effort is the
   server's `high` unless you pass one.
3. It parses the reply with the Codex TUI's rules: JSON `{"suggestion": …}`, trimmed, not empty,
   at most 240 characters, one line, no control characters. Anything else is `null`.

**Differences from the app (on purpose, and why):**

- **No fork.** A live Codex thread can only be forked inside the app-server. APIPlan rebuilds
  the conversation from its visible messages instead. That means the parent's instructions,
  tools and tool calls are not part of the prefix. So the first prediction for a conversation is
  not a cache read against the conversation itself. Later predictions on the same prefix are.
- **Any conversation.** This is the point of fire17's ask: Codex conversations (rollouts),
  Claude Code sessions (transcripts), or plain `{role, content}` messages, all turned into the
  OpenAI format. So the harness can predict the next message in any session.
- **No sampling and no model gate.** Every call gets a prediction. A model the server lists as
  unsupported still runs, and the result carries `unsupported_model: true` as a warning.

### CLI

```
composer                          # your newest Codex thread
composer --codex <thread-id|last>
composer --claude <session-id|last>
composer --file convo.json        # [{role, content}, …]
echo '[{"role":"user","content":"…"}]' | composer
composer config                   # live server config + prompt
composer --json …                 # full record: usage, cached tokens, latency, x-codex windows
```

The same command is also `apiplan composer …`. Exit codes: 0 = suggestion printed, 2 = the model
chose none, 1 = error. `-m` picks the model (default `gpt-6-astra`), `-e` the effort,
`--prompt-file` overrides the prompt, `--max-chars` limits how much history is sent (default
200,000 characters, newest whole turns).

### API (`apiplan serve`)

```
GET  /v1/composer/config[?fresh=1]   → {object: "composer.config", source, …config}
POST /v1/composer/predictions        → {object: "composer.prediction", suggestion, raw, model,
                                        effort, prompt_version, config_source, tagged, usage,
                                        latency_ms, windows}
     body: exactly one of
       messages: [{role, content}]        (OpenAI or Anthropic content shapes)
       codex_thread: "<id>|last"          owner only
       claude_session: "<id>|last"        owner only
     optional: model, effort, tag, prompt, system, max_chars, prompt_cache_key
```

`codex_thread` and `claude_session` read this machine's own transcripts. They are allowed only
for the owner: the legacy key, or a keyless caller on loopback that did not come through a proxy.
This is the same rule `/v1/usage/keys` uses. A per-client key gets 403. Every call is written to
the usage ledger under the caller's key.

## Verification (2026-10-10, observed)

- `composer config`: source `live`, version 5, effort high, enabled.
- CLI on messages: "Can you make it handle filenames with spaces?" (273 input, 78 output, 4.3 s).
- CLI on `--claude <this session>` and `--codex last`: both ran. The Codex one returned `null`
  on a one-line "Reply with exactly: OK" thread, which is the right answer there.
- Route on a scratch `serve --port 8799`: config 200; prediction 200 ("Add tests to verify
  --dry-run …"); bad body 400; non-Codex model 400; `claude_session` 200; ledger lines written.
- `bun test`: 1414 pass, 0 fail (full suite, including 24 new composer tests).

## Codex CLI upgrade done in the same task

0.158.0 → 0.162.1 (`bun add -g @openai/codex@0.162.1`). Backup is at
`~/.codex/backup-20261010-152109`. Rollback: `bun add -g @openai/codex@0.158.0`. Checked after
the upgrade:

- `codex exec` answers.
- The model is still gpt-6-astra, both with and without `-m`.
- auth.json keeps the same key layout and was not moved to the keyring.
- APIPlan's openai calls work, through the CLI and through `serve`.
- codex-ingest `--test` 27/27, and `--check` parses the new rollouts.
- `apiplan live-check` (realtime) ok.

Upgrading the CLI does not bring composer predictions. They need the desktop app at 26.1007 or
later. The installed app (26.908) is older than the feature.
