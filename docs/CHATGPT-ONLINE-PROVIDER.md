# ChatGPT website provider for APIPlan and OM

Status: implementation and real OM harness fixtures pass. Live Chat/Instant acceptance is in progress; do not treat the fixture as proof of website reliability. Live Work tests are disabled while the account's Work quota is exhausted.

## Routes

| APIPlan name | Canonical model ID | Website selection | Verification |
|---|---|---|---|
| `online/chat` | `online-chat-latest` | Chat / Latest / Instant | Picker and simple generation observed; five-round OM acceptance pending |
| `online/astra` | `online-gpt-6-astra` | Work / GPT-6 Astra / Light | Picker observed; live inference deferred because Work quota is exhausted |
| `astra` | `gpt-6-astra` | Existing OpenAI subscription provider | Existing route preserved |

The Chat picker currently offers Latest, GPT-5.6 Sol and GPT-5.5; it does not offer Astra. The provider never silently substitutes Chat Latest for requested Astra.

### Why "Latest" is not Astra (evidence, 2026-09-16)

This gets asked repeatedly, so here is the account's own catalog rather than an inference. `~/.apiplan/chatgpt/accounts/default/takeout/account/models.list.json` (captured 2026-09-15 17:12 local) shows `Latest` is a version **group**, not a model:

| Field | Value |
|---|---|
| `versions[id=latest].slugs` | `gpt-5-6`, `gpt-5-6-instant`, `gpt-5-6-thinking`, `gpt-6-pro` |
| `secondary_title` | `GPT-5.6 Sol` |
| `default_model_slug` | `gpt-5-6` |

Astra's only slug anywhere in that capture is `gpt-6-astra-wm`, one of the `-wm` family (`gpt-5.5-wm`, `gpt-5.6-sol-wm`, `gpt-5.6-terra-wm`, `gpt-5.6-luna-wm`, `gpt-6-astra-wm`). `Latest`, `Instant`, `Medium`, `High`, `Extra High` and `Pro` carry titles with no slug — they are picker rows, not models.

So the accurate statement is narrower than "Chat cannot reach a GPT-6": the `Latest` group's top member **is** a GPT-6 (`gpt-6-pro`). What Chat cannot reach is **Astra specifically**. Anyone re-checking this should read the catalog, not a generation: `GET /backend-api/models` creates no conversation and sends no message.

## Selecting the mode from the CLI

`--chatmode` and `--work` make the composer mode an explicit, per-invocation choice on any model command. They pick the **surface**, not the model, and they never touch the desktop app's saved settings.

| Command | Surface | Model actually used |
|---|---|---|
| `astra "hello there"` | unchanged default | `gpt-6-astra` via `/backend-api/codex/responses` |
| `astra --work "hello there"` | the same, said out loud | `gpt-6-astra` — byte-identical request |
| `astra --chatmode "hello there"` | signed-in website, Chat composer | `online-chat-latest` — **not Astra**, and stderr says so |
| `astra --mode chat\|work "…"` | same choice, one flag | as above |

Rules the implementation holds:

- **`--chat` is unrelated and unchanged.** It has always meant "read a JSON messages array from stdin"; re-pointing it would break every script that pipes a transcript in. The mode flag is deliberately `--chatmode`.
- **Mode and effort are independent.** An effort the chosen mode does not expose fails (`effort 'high' is not available on ChatGPT website — Latest; valid: low`) and is never silently downgraded.
- **Contradictions are refused by name**, never resolved by argument order: `astra --chatmode --work` exits 1 with `choose one mode: --chatmode and --work contradict each other.`
- **The mode reaches the transport**, not just the parser: it arrives in the `selection` block the website driver acts on, and a mode the route cannot serve raises `MODE_UNAVAILABLE` rather than substituting the model the other mode does offer.
- **Mode flags are ChatGPT-only.** `opus --chatmode` exits 1 (`Claude Opus 5 is an anthropic model and has no
  Chat/Work setting`) rather than re-pointing another vendor's command at chatgpt.com, which would send the
  prompt to an account the command never named.
- **No stale-daemon hazard.** `providerCanUseWarmDaemon` excludes `online`, so a Chat-mode request always executes in-process against current code.

Tests: `test/astra-mode.test.ts` (34, no network), helper `test/helpers/astra-mode-probe.ts`.

Both website models accept `effort: low`. The website mapping is Instant for Chat and Light for Astra. Other levels fail explicitly until exposed and validated. These are signed-in website generations, using the selected ChatGPT browser account. There is no Codex token or OpenAI API fallback.

## API and OM

The provider uses the ordinary APIPlan OpenAI `/v1/chat/completions` and Anthropic `/v1/messages` endpoints. A fresh `apiplan serve --port 8791` loads it without replacing an existing API process. Existing resident API servers must be upgraded through their normal safe handoff before their model list includes these additions.

Example request to that isolated server:

```sh
curl http://127.0.0.1:8791/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"online/chat","stream":true,"messages":[{"role":"user","content":"Say hello"}]}'
```

Use the server's configured API authentication if enabled. APIPlan's generated OM roster contains `apiplan/online-chat-latest` and `apiplan/online-gpt-6-astra`, both using OM's existing Anthropic transport. No custom OM networking implementation is needed. The roster reports conservative local policy caps of 32K context and 4K output, text input only, and no invented token prices. These caps are not claims about the website's vendor limits.

## Tools and state

Caller-supplied tool schemas travel in the conversation bootstrap. Complete nonce-bound tool frames become normal tool-start/argument/stop deltas; OM executes its own tools and returns correlated tool results on its next request. APIPlan does not execute arbitrary caller tools. Fenced examples remain inert, malformed completed frames fail, and repeated conflicting IDs fail.

Every request submits the complete structured API history to a dedicated website conversation. This preserves a stateless API contract. Reusing one website conversation across API requests is a future optimization and is not currently claimed. Native system-role privilege is not available on the website: roles and system instructions are serialized into the harness prompt.

The adapter currently exposes text and conversation-based tools. Website file, image, voice and invoice operations remain available through `chatgpt`; the new API text route rejects image input explicitly rather than omitting it. Media parity through this API is not yet complete.

## Recovery and monitoring

```sh
chatgpt online list
chatgpt online status api-<40-hex-characters>
```

The status response includes account/model, timestamps, conversation references, error, result counts, private receipt path and recovery action. It omits message content by default; `--include-raw` explicitly includes the stored receipt. These operations read disk and do not start a browser.

Requests have account/workspace-bound canonical digests and private durable receipts. An identical completed request returns the saved result. A positively known pre-submission failure can be tried again. An unknown or concurrent request is never automatically resubmitted. Do not delete its receipt or lock to force a retry. Cancellation attempts one stop on owned active surfaces; a cancelled or uncertain write never receives a success terminal.

Protocol and website flow changes are loaded between requests. In-flight requests retain their loaded code. The CLI bypasses a potentially stale warm daemon for online models, preserving unrelated daemon traffic and current account selection.

## Tests

Deterministic adapter and real installed OM harness proof (injected website driver; no website generations):

```sh
APIPLAN_OM_AGENT_PROOF=1 bun test test/online-om-agent-loop.test.ts
```

Opt-in live acceptance (real OM Agent → APIPlan → signed-in website, **Chat/Instant only**):

```sh
APIPLAN_ONLINE_LIVE=1 bun test test/online-om-live.test.ts
```

The live test requires five user rounds, one unpredictable local tool result per round, automatic OM continuation and exact final answers. `APIPLAN_OM_RUNTIME` may select an installed runtime; evidence records its actual resolved path. `APIPLAN_ONLINE_LIVE_RECEIPT` may select the result file. The test rejects Work model overrides.

See [the implementation oracle](CHATGPT-ONLINE-ORACLE.md) for failure branches and completion criteria.

## Follow-on: sol, terra, luna

Derived from the same `models.list.json` capture (2026-09-15 17:12), by splitting every slug on the `-wm`
(work-mode) suffix. This is catalog evidence, not a picker observation; confirm against the live picker before
relying on it.

| Command | Chat-reachable slugs | Work-mode slug | Can it have both modes? |
|---|---|---|---|
| `sol` | `gpt-5-6`, `gpt-5-6-instant`, `gpt-5-6-thinking` | `gpt-5.6-sol-wm` | **yes** |
| `luna` | `gpt-5-6-mini`, `gpt-5-6-t-mini` | `gpt-5.6-luna-wm` | **yes** |
| `terra` | none | `gpt-5.6-terra-wm` | **no — Work only** |
| `astra` | none | `gpt-6-astra-wm` | **no — Work only** |

This independently corroborates the observed Chat picker rows (Latest, GPT-5.6 Sol, GPT-5.5): those are exactly
the titles that own a non-`-wm` slug. Terra and Astra own none, which is why neither appears in Chat.

Two consequences for the rollout:

1. **`sol --chatmode` is already correct by construction.** `Latest`'s `default_model_slug` is `gpt-5-6`, whose
   title is *GPT-5.6 Sol* — so routing `sol` to `online/chat` lands on Sol itself, not a substitute. `luna` and
   `terra` do not have that luck: Luna is a distinct picker row, and Terra has no Chat presence at all.
2. **What blocks a clean rollout is the registry, not the mode plumbing.** `models('online')` holds exactly two
   entries, so "Chat / GPT-5.6 Luna" has no addressable route. Adding sol and luna means new `online/*` entries
   plus their `selection()` mappings; `terra` should instead get the `MODE_UNAVAILABLE` refusal that already
   exists, since the website has nothing to route it to.

The mode plumbing itself (`CallOpts.mode` → `selection()`) is model-agnostic and needs no change for any of them.
