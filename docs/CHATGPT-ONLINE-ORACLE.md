# Website provider oracle — 2026-09-15

## Context
Expose signed-in ChatGPT website generations as regular APIPlan provider `online`, including `online/astra`, and use existing OM Anthropic/OpenAI harness protocols. Preserve existing bare astra/Codex route. No API token generation fallback. Parent owns generic conversation-to-tool bridge. Browser worker owns observer and mode verification. Integration worker owns shared transport, registry and roster. OM worker owns contract validation.

## Decisions
Add optional Provider.open(built, signal):Promise<Response> and shared openProviderRequest(p,built,signal), preserving existing synchronous creds/build, API credential lifecycle and readers. Default delegates unchanged POST fetch. Website adapter supplies internal NDJSON Delta frames, explicit terminal only after observed completion. `build` carries account selection without a secret; `open` verifies website identity before use. Use dedicated website conversations; full structured transcript initially, session reuse only against exact prefix and complete receipt. Generic tools are emitted to caller, never executed inside provider. Preserve ordinary code/markdown as display text; parse tools only semantic protocol channel. Offline fixtures cannot establish live success.

## Dead ends
Do not use Jimmy's API-only special case: engine/daemon would miss route. Do not silently map website Latest to Astra. Do not accept stable text or EOF as response completion. Do not replay unknown submissions. Do not copy API token price/context limits into website model card.

## Risk register and 12-step branches
Each row is success | loud failure | partial-success trap; detection -> response. Likelihood and impact follow.
1 Registry: exact online route | missing id | bare astra hijacked; resolve assertions -> use distinct family and exact alias scope. Likely/medium.
2 Credential: configured account | missing config | config mistaken for live auth; driver identity proof -> reject mismatch. Likely/high.
3 Transport: all four consumers | unsupported URL | only HTTP API works; mock transport tests across consumers -> shared helper. Likely/high.
4 Mode: Work/Astra exact observed | unavailable | Latest silently served; verified selection -> fail pre-send. Likely/high.
5 Effort: low observed | unsupported | advertised high absent; fixture/live ladder -> exact mapping, no fallback. Likely/medium.
6 Prompt: complete roles/tools/results | unsupported media | omitted old turns; transcript roundtrip tests -> reject unsupported input. Likely/high.
7 Submission: one owned write | pre-send failure | accepted then timeout; durable request receipt -> no automatic resend. Likely/high.
8 Stream: valid complete calls | malformed frame | fenced example executed; semantic parser nonce/fence tests -> refuse errors. Likely/high.
9 Tool correlation: unique ids | unknown tool | duplicate changed args; parser plus offered-name check -> terminal protocol error. Likely/high.
10 Continuation: authoritative results | unmatched tool id | model invents output; serialize call/result provenance, live caller-derived random test -> require actual result. Likely/high.
11 Cancellation: owned stop confirmed | stop unavailable | close tab declared cancelled; abort fixture + live observation -> distinguish requested from confirmed. Likely/high.
12 Terminal: explicit bound assistant finish | SSE failure | stale Stop remains; observer proof + terminal marker -> unknown, never green. Observed/high.
13 Roster: OM accepts entry | schema rejects | invented context/cost; actual OM parser -> conservative adapter cap explicitly local policy, omit prices. Possible/medium.
14 Retry: complete receipt cached | unknown refused | duplicate website writes; same request digest/receipt -> block unknown and concurrent duplicates. Likely/high.

## Playbooks
OUTCOME_UNKNOWN: inspect private receipt; never repeat write. Wrong model: inspect actual picker labels, do not alias guessed labels. Truncated stream: preserve failure, no end_turn. Tool JSON mismatch: error before emitting that call. Account switch: next build captures new account; in-flight call stays bound to prior account. Unknown observer schema: content-free types/counts only, ask observer owner to fix parser against synthetic response. Browser daemon EPERM: not proof of death; do not restart Arc or remove locks.

## Invariants and acceptance
Run Bun focused online-provider and online-wire fixtures; build CLI; verify old aliases. Live done means five+ real request turns through actual OM runtime, streamed complete tool args, caller-computed unpredictable result returned, exact requested website Astra mode+low effort verified, terminal completion, cancellation/unknown handling evidence. Fake drivers test adapter contracts only. No success claim on mocks.

## Premortem / quadrants
Failure history: browser drift silently changed model, parser treated prose as tools, retries duplicated prompts, API gateway appeared healthy while website stalled. Guards are identity/selection receipts, semantic protocol channel, durable replay barrier, authoritative terminal. Known unknowns: actual Work label and SSE patch schema, OM process timeout, website context capacity. Unknown knowns: existing four build/fetch sites and OM Anthropic tool support are mapped. Unknown unknowns: log schema/count deltas and fail closed on divergence.

## Escalation
Stop only affected branch on mismatch, write symptom/evidence/attempts to field log and notify root; continue independent fixtures. Never improvise model fallback, completed status, or direct backend generation.

## Field log
2026-09-15: Six-turn harness observed; one child full sequence; second observation failed. Passive observer fixture-tested, live schema pending. Provider not yet implemented.

## Chaser
The deceptive failure is a successful-looking local API that merely relays plausible text. I would trust an unpredictable tool result carried across a real website turn much more than ten green interface fixtures. Preserve the evidence that distinguishes those. — Root, 2026-09-15
