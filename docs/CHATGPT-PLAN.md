# ChatGPT terminal — execution ledger

## User intent

Use the current signed-in ChatGPT website account through a complete CLI and a polished TUI. Preserve the website's conversations, projects, GPTs, message trees, model and effort selection, media, uploads, image generation, dictation, and live voice. Account selection must later accept AccountTracker/APIPlan accounts without rebuilding the application. All TUI actions must also be scriptable.

## Architecture

- Account-scoped persistent nodriver Chromium session; the website performs generation and its own authentication checks. No Selenium, chromedriver, Playwright, or Codex credentials.
- Typed service operations shared by CLI, JSON/NDJSON interface, and TUI.
- Paginated data enumeration independent of sidebar expansion, preserving raw fields and every message-tree node.
- Account-scoped SQLite index with explicit coverage receipts; partial enumeration never reports complete.
- Browser control and live terminal viewport for features without stable structured adapters.
- An evidence ledger distinguishes implemented, observed, verified, unavailable, and blocked capabilities.
- Secrets stay in browser storage. Private state is outside the repository. AccountTracker/APIPlan integration supplies browser-session references, never Codex tokens.
- Browser discovery and adapters: attach to an existing Arc/Chromium debugging endpoint when available, or launch a managed browser. Never restart the user's daily browser automatically. Extend discovery to every installed browser; explicitly report browsers that do not support the selected transport.
- Headed/headless switching relaunches the same owned profile and restores its open URLs. Attached daily browsers are never stopped or relaunched.

## Delivery checklist

- [ ] Account profiles, current-session import, future credential-provider interface
- [ ] Browser daemon, lifecycle, concurrent-client ownership, login recovery
- [ ] Complete conversation/project/GPT enumeration and raw export
- [ ] Conversation trees, resume/edit/branch/regenerate, model and effort controls
- [ ] File/media capture, uploads, image generation, dictation and live voice
- [ ] Shared command registry and JSON/NDJSON CLI
- [x] Keyboard TUI, search, inspector, command palette and browser passthrough
- [ ] Real account capability map and verification receipts
- [x] Tests for pagination, isolation, tree fidelity, streaming and TUI input
- [ ] Integration, documentation, live validation
- [ ] All settings/interaction discovery, including nested options and account-specific surfaces
- [ ] Invoice list/download/all/watch; idempotent import through existing invoices project's parser, naming and ledger
- [ ] Original ChatGPT takeout request; resumable local lossless takeout with manifest, hashes, media, coverage, failures
- [x] Structured monitoring/event stream, classified errors, recovery guidance and drift signals
- [x] Hot-reloaded versioned adapters, validation and rollback; unknown writes never auto-replayed
- [x] Durable per-account stop switch (`chatgpt freeze` / `thaw`) gating every site-bound path, plus daemon-free direct mode for local reads

## Initial evidence

2026-09-15: existing APIPlan `openai.creds()` can read `/backend-api/conversations`, `/backend-api/models`, and `/backend-api/settings/voices`. This credential reports two conversations; it must not be silently equated with the user's website profile. CUA's in-app browser is logged out. Native Arc accessibility is unavailable (Computer Use permissions not granted). APIPlan working tree has unrelated existing changes; this implementation uses dedicated modules and narrow integration edits.

2026-09-15 steering: website login only, external to Codex. User explicitly prefers nodriver and authorized relaunching Arc. Relaunched Arc with loopback debugging port 9223; nodriver attaches to its Default profile. Dedicated ChatGPT tabs are signed in as the intended Pro account. Full pagination found 1,054 active conversations (11 pages), zero archived. Current website project response has one project with cursor pagination. Billing now exposes transaction history inside Settings, with an observed transaction-history endpoint and Stripe invoice link. Do not use Codex tokens in any delivered path.

## Current execution evidence

- Standalone `chatgpt` shim installed; `apiplan chatgpt` delegates to the separate website client. No OpenAI provider credential code is imported by this client.
- Real website generation created a dedicated integration chat and streamed `CLI_OK`; Instant follow-up `FOLLOWUP_OK` was recovered from the exact server message when the DOM lagged. Message edit was submitted once, awaiting receipt verification after throttling.
- Model/power menus use observed labels (Instant, Medium, High, Extra High, Pro), with failed selection restoring the original setting.
- Invoice transaction pagination, real Stripe PDF download and existing-project import verified. Existing invoice was deduplicated correctly. Six-hour invoice watcher enabled in the detached daemon; state persists across restarts.
- Browser/actions/service revisions hot-reloaded without losing active tabs. Per-surface locks prevent invoice/media work blocking chat UI. Worker shutdown has a bounded graceful/TERM/KILL sequence; attached Arc stays running.
- Local takeout checkpointed 235 complete raw trees at the latest observed checkpoint. Bulk conversation reads hit HTTP 429; shared request pacing and Retry-After backoff are active. The export remains explicitly partial while waiting for the account limit.
- Media discovery found actual library node/POST catalogs, generated-image cursor pagination, and the file download resolver used by sediment pointers. The refreshed same-window catalog observed 103 generated rows and 22 uploaded rows with one overlap, 53 image-library rows, and 129 unique assets across gallery and image-library scopes. Incremental export completed all 248 current target references: 249 files are retained, zero targets failed or remain, and manifest integrity/download completeness are true. Catalog completeness stays false because the bootstrap scalar was 120 while the gallery uniquely contained 124 assets; the 129 cross-catalog union is broader still. The retained 249th file is one 4,898-byte historical version absent from the refreshed target set.
- Settings mapper found 17 tabs and is expanding nested menus without changing settings. Official export confirmation dialog was inspected and cancelled; no official export request was sent.
- Current targeted integration run: 45 tests passed, plus isolated core/watcher child suites. Tests use separate account homes and module caches.
- Managed Chrome mode migration is still being diagnosed; Arc attachment and current-session website operations work. Do not mark managed head/headless login transfer verified yet.

- Capability schema3 now distinguishes partial dispatches and historical adapter evidence, recursively exports nested settings controls with trigger paths, and explicitly separates GPT bootstrap from owned My GPTs. Health, Sites, Work, Apps, Library and Images are cataloged scopes; generic UI access never establishes full parity. Capability tests exercise these scope distinctions.

- Large binary transport uses 262,144-byte browser chunks. A live 6.7 MB transfer passed; the approximately229 MB asset has not yet been reached, so large-video completion remains unverified.
- Automatic runtime gating checks/reloads before operations and retains the last good revision if a candidate fails. Settings mutation fixtures cover no-op, single switch/readback, unsupported/disabled/ambiguous controls, missing options and explicit text commit (7 tests,30 assertions). No live settings were changed by these tests.

- Conversation management was live-verified only on the dedicated integration chat: rename/restore, pin/unpin, archive/unarchive. Archive verification binds the exact `/c/ID` row to its observed unarchive control in Settings → Data controls → Archived chats. Restoration verifies removal there and reappearance after refreshing the auxiliary sidebar. Original title and active/unpinned state were restored; no other chats were changed and no share link was published.

## Documentation checkpoint

See [CHATGPT-QUICKSTART.md](CHATGPT-QUICKSTART.md) for the full command inventory and rate-limit/agent recovery playbook. The latest reported CLI baseline is 81 passing tests, with the source-local suites and final combined total still pending. My GPTs owned pagination returned zero with a complete scope receipt; bootstrap/public discovery remain separate. Takeout resume now refreshes catalogs and changed conversation timestamps. Explicit audio injection operations are implemented, while end-to-end dictation transcription remains under diagnosis. OS-login autostart is implemented but not claimed installed.

## Current delivery and queue follow-up

- TUI reload host and local queue passed PTY tests, including successive revisions, syntax rejection, queued drafts across generation and state handoff. Reload during an active RPC/generation is staged until that operation settles.
- Outgoing attempts and observed website submissions now emit separate events. Website-native queue and steering are still unverified; do not label a local queued draft as submitted.
- Work-limit detection uses site notices or a selected-Work zero-remaining usage control, not arbitrary conversation prose. Fallback must confirm Chat before updating the TUI header.
- Background takeout remains incomplete under server rate limits. Checkpoint integrity, a live daemon and backoff are separate from completeness; stale runs need a supervisor and account catalogs must refresh on resume.
- Remaining queue work: durable CLI queue operations sharing TUI state, native website queue discovery, and steering only where an observed control verifies its outcome.

## 2026-09-16 — stop control, direct mode, documentation safety pass

**Freeze switch.** `src/chatgpt/freeze.ts` adds one durable per-account flag
(`~/.apiplan/chatgpt/accounts/<id>/freeze.json`). `BrowserWorker.start` refuses to launch a browser
while frozen and `BrowserWorker.call` refuses every worker operation outside the activity-reducing set
(`status`, `close`, `surface.close`, `audio.output.stop`, `audio.clear`, `request.info`, `network`,
`snapshot`). Errors carry `code:"FROZEN"`, `retryable:false` and "no request was sent". `service.ts`
adds `freeze.set` / `freeze.status` and makes `status` frozen-aware (it skips the identity read and
starts nothing while frozen). `bin/chatgpt.ts` exposes `chatgpt freeze [--reason TEXT]`,
`chatgpt thaw` and `chatgpt freeze status`; `tui.ts` adds `/freeze`, `/thaw` and the ❄ FROZEN header
marker, writing the flag in the TUI process itself and re-reading it from disk every 5 s. The website's
own Stop control stays clickable while frozen through an in-process `Symbol` (`ALLOW_WHILE_FROZEN`)
that JSON cannot forge.

**Direct mode.** `daemon.ts` `direct()` runs `DIRECT_READ_OPERATIONS` in-process with no daemon and no
browser, engaged by `CHATGPT_DIRECT=1` or automatically when the daemon is unreachable. Any other
operation fails with `code:"DAEMON_REQUIRED"`. The direct service is constructed with
`autoResume:false`, so a local read can never wake the background archive writer.

Verification status (honest): the refusal path is **live-observed on his account** —
`events.jsonl` records `freeze.set` at 06:25:30.237Z, a frozen `status` completing in 17 ms with no
browser, `conversations.list` refused at 06:26:01.865Z with `code:"FROZEN"` at `browser.start`, and
`freeze.status` answering in 1 ms. No site request was made to obtain that evidence.
`test/chatgpt-freeze.test.ts` covers durability, the allowed-operation set, the unforgeable `Symbol`,
the refused launch, frozen `status`, Stop-while-frozen and `autoResume:false` — **fixture evidence**.
Not tested: freeze arriving mid-generation on the live site, thaw-and-resume of a real run, a launchd
respawn observed while frozen.

**Documentation safety pass.** `CHATGPT-QUICKSTART.md`, `-ORACLE.md`, `-PLAN.md`, `-COVERAGE.md`,
`-SLASH-COMMANDS.md`, `-ARCHITECTURE.md` and `-MEDIA-MAP.md` were rewritten so that a weak executor
cannot mistake a catalogued capability for permission: a cost index naming requests, reversibility and
required permission for every site-bound command; explicit blocks on `takeout` (the 1,063-conversation
crawl), `takeout --original` (irreversible official export), `takeout watch` (unattended resumption),
`settings set`, `conversations share`, `queue run`, `invoices --all/--acknowledge`, the `ui`
primitives and `api request`. Corrections made in the same pass: `chatgpt status` is live unless
frozen; `conversations.unshare` is routed but not implemented; the oracle's self-authorization and
stale-lock sentences were scoped so neither reads as permission. No capability was removed from any
document. Full pass record: `.deify/chatgpt-cli/wargame/docs-safety-pass.md`.

Account state at the time of writing: frozen (`freeze.json` `frozen:true`, reason *"resumed after his
STOP; site traffic stays off until he says go"*), takeout supervisor disabled, invoice watcher
`paused:"action-required"`. `conversationReadsPaused` is **false**, so the freeze flag — not the
takeout pause — is what currently stands between a command and a resumed crawl.

## Recovery oracle

Read [CHATGPT-ORACLE.md](CHATGPT-ORACLE.md) before continuing browser/session, queue, reload, archive or media work. It records the live timeout incident, phase-specific recovery and twelve failure branches along the critical path.


## 2026-09-15 14:12Z — Session recovery checkpoint

The reproduced timeout/restart/missing-output incident is recovered. Auth is bounded with an independent recovery tab; process liveness distinguishes ESRCH from EPERM; daemon owner generations protect newer state. Roleless streaming assistant turns and Pro thinking now appear with explicit DOM provenance, yielding to server message IDs when mounted. TUI read-only recovery, virtualized-prefix history, recovered-active queue/stop/detach behavior and hot reload passed PTY checks. The actual user's original reply completed and appeared in the running TUI (16,704 characters, no error). No replay occurred; one unresolved local draft remains separate.

Independent full ChatGPTService send/receive: 15.817 seconds, one verified submission, five streamed text events, exact expected reply. Integrated suite: 211 passed / 0 failed / 716 assertions / 51 files. Live Voice input plus non-silent WebRTC output verified earlier; durable CLI queue integrated. Capability report retains semantic verification gaps rather than promoting dispatch completion to parity. Takeout materializes all observed targets before detail reads, including unattempted entries on early rate limits.

ASTRA MIND received progress and recovery milestones at the user's request. User also explicitly requested WhatsApp progress relays. Mind independently verified that authorization, but its detailed relay was rejected by automatic approval review; shorter general relay texts were delivered to Mind afterward. Actual WhatsApp delivery is not yet confirmed. Coordination receipts live outside this repository under livemind/chatgpt-build-coordination.

Remaining broad work: complete archive and media catalog reconciliation; conditional settings/project/GPT operations; live edit/branch/regenerate semantic validation; native website queue/steering; authenticated managed/headless migration; full multimodal/TUI parity. Do not claim perfect or gap-free coverage.

## 2026-09-15 14:33Z — Composer, target set and shared queue progress

Message timestamps and top-line sent-history recall/multiline editing passed 21 tests (74 assertions), including PTY, reopen and hot reload. Website creation times are preferred; local and observed times are labeled explicitly.

Live archive now tracks all 1,063 observed targets with a valid hash and zero missing coverage entries. 244 trees are complete, 819 partial. The positively alive existing writer refreshed at 14:32Z and respects the new 14:47:28Z rate deadline; no restart occurred.

Durable queue adds accept optional clientId, atomically persisting the original draft hash and item identity. Retries preserve edits/completion; removed items remain tombstoned. Module/service checks passed 16 tests; actual CLI checks passed 3. Shared TUI migration is integrating against that contract, keeping queues paused and unknown attempts separate.

Task-specific enumeration now recognizes actual task_id records, follows opaque cursors, preserves raw pages and rejects contradictory termination/counts. Four unit cases and decoding the real saved two-task response passed; fresh live archive adoption remains pending. ASTRA MIND received the reduced progress relay in its durable inbox; WhatsApp delivery remains unconfirmed.

## 2026-09-15 15:30Z — Media terminal and archive read-only checkpoint

Media export operation `c9a2120f-f7e7-46bc-887d-3091acad3bba` completed at 15:22:30Z. Its local receipt reports 248 targets, 249 retained files, zero failures, zero damaged files, zero remaining items, integrity true and download completeness true. Overall `complete` remains false only because the catalog-count receipt is partial: bootstrap 120 does not reconcile with 124 unique gallery assets or the 129-item gallery/image-library union.

The conversational harness parser executes only exact, complete `<tool_call run="RUN_ID">…</tool_call>` frames at line start outside quoted/code text. Fenced examples, inline-code openings and blockquoted openings are inert in parser tests. This is protocol fixture evidence; a live website streaming run remains a separate acceptance gate.

The archive manifest still reports 1,063 conversation targets: 244 complete and 819 partial, unchanged from the 14:33Z checkpoint. The partial set is now explicitly split into 561 failed reads awaiting retry and 258 seeded targets with no detail attempt. Five non-conversation required scopes also remain partial (`tasks.list`, `plugins.list`, `connectors.list`, `pins.list`, `capabilities.list`). At 15:30Z, both takeout locks named PID 82562 and that daemon process was alive; operation `bf7ebdad-51a0-4cb4-a80b-0e089fd5d248` had no terminal event. The latest observed conversation-detail 429 set retry-at 15:30:21.842Z. These facts establish an owned, rate-limited incomplete run, not forward archive coverage.

## 2026-09-15: regular website provider and OM acceptance

Current priority: [website API provider](CHATGPT-ONLINE-PROVIDER.md), following [its oracle](CHATGPT-ONLINE-ORACLE.md). Shared provider transport, distinct `online/chat` and `online/astra` routes, account/workspace binding, canonical durable receipts, tool translation, hotloaded request modules and disk-only `online.list/status` are implemented. Existing bare Astra keeps its original provider.

Real installed OM Agent fixtures passed six automatic tool executions/result continuations and abort. Live Chat testing has exercised actual tool execution and a correct returned random result; the decoder is being hardened against provisional DOM closing tags and cursor text before five-round live acceptance. Do not mark live acceptance from fixtures. Only Chat/Latest/Instant live tests are authorized during the current Work quota exhaustion. The Chat picker does not offer Astra; Work/Astra inference remains deferred.

Remaining: complete five-round real website/OM acceptance, rerun six-turn concurrent child harness with final protocol consistency, and safely expose the provider in the existing API server and OM roster. Media parity in the new API and website conversation reuse across stateless API calls remain explicitly separate work.
