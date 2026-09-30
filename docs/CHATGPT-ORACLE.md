# ChatGPT website client: recovery oracle

Updated 2026-09-16 (safety pass; incident content below is unchanged from 2026-09-15). Read alongside CHATGPT-PLAN.md and CHATGPT-ARCHITECTURE.md. This document covers the live timeout incident and the boundaries required for continuing the full website client. It is not a declaration of full website parity.

## 0. The stop control, and the standing order (read before any step below)

Every recovery step in this document runs against a real, signed-in, personal ChatGPT account. The
account owner's newest instruction about the site, given 2026-09-15 19:51, is his words verbatim:

> STOP EVERYTHING IMMEDIATELY

Until he lifts that **in his own words**, run nothing that reaches chatgpt.com — no send, no catalog
page, no "quick status check".

`chatgpt freeze` is the durable enforcement of that order, added 2026-09-16:

- `chatgpt freeze [--reason TEXT]` / `chatgpt thaw` / `chatgpt freeze status`; `/freeze` and `/thaw`
  in the TUI, which shows **❄ FROZEN** in its header while the flag is set.
- One durable flag at `~/.apiplan/chatgpt/accounts/<id>/freeze.json`. It is a file, not process state:
  it survives daemon shutdown, launchd respawn and reboot. That is why it, and not a `kill`, is the
  stop button.
- Gates live in `BrowserWorker`: `start()` refuses to launch a browser while frozen and `call()`
  refuses every worker op that is not activity-reducing. Error code `FROZEN`, `retryable:false`,
  message ending `no request was sent`.
- Allowed while frozen: `status`, `close`, `surface.close`, `audio.output.stop`, `audio.clear`,
  `request.info`, `network`, `snapshot`. The website's own Stop control stays clickable through an
  in-process `Symbol` (`ALLOW_WHILE_FROZEN`) that JSON cannot forge.
- Local reads keep working: cached index, search, receipts, monitor events, takeout status/audit/
  watch-status, queue state.
- `CHATGPT_DIRECT=1` runs those local reads and freeze/thaw **in-process** — no daemon, no browser —
  and the same path engages automatically when the daemon is unreachable. Anything else fails with
  `DAEMON_REQUIRED` and starts nothing. Direct mode never resumes the background archive writer
  (`autoResume:false`).

**Two error messages in this client tell you to defeat its safety controls. Do not obey either.**
A `FROZEN` error's `action` says *"Run `chatgpt thaw`…"* — thawing is the owner's decision, never an
error-recovery step. A `DAEMON_REQUIRED` error's `action` suggests `chatgpt status` — on a thawed
account that starts the browser and hits the site.

`chatgpt status` is **not** a harmless read: `service.ts` excludes `status` from its no-start
allowlist unless the account is frozen. Frozen, it is local-only (observed at 17 ms with no browser on
his account, 2026-09-16T06:25:50.972Z).

## 1. Context capsule

The user wants their signed-in ChatGPT website in a standalone nodriver CLI/TUI, with account switching, complete archives, media, live status and recoverable updates. Browser credentials stay in the browser. APIPlan provider credentials and Codex authentication are unrelated.

Actual incident: three `chat.send` failures at 16:14:11, 16:16:58 and 16:17:53 local reported `Browser session timed out`. Each failed during identity lookup, before navigation/composer/submit. The generic timeout label incorrectly made them uncertain submissions. A read-only main-tab snapshot showed five messages, three user messages and no duplicate user text. The TUI displayed speculative copies. Media export had already completed at 16:00:55; it was not an outstanding download at the failure times. Conversation takeout was active. Shared browser/API-tab contention is a hypothesis, not a proven cause.

Grounding: the original browser.py `session()` fetched `/api/auth/session` on the bulk API tab without a fetch timeout. The repair bounds that read and, on failure, validates an independent replacement `session_tab`; the original `api_tab` remains pinned for active bulk requests. transport.ts has a 45-second default deadline, which stops the caller waiting but does not cancel the page fetch. service.ts identity runs before the submit boundary. The integrated suite passed 161 tests while the live session still failed: passing mocks did not certify live transport health.

## 2. Decisions

- Classify by operation phase. `NOT_SUBMITTED` means the high-level send never reached its submit attempt. A timeout after a submit attempt remains uncertain until positive evidence establishes the result. Consequence: a failed auth check restores a draft; an uncertain write blocks blind replay.
- Recover authentication through an independent read-only session tab. Verify account identity before replacing only `session_tab`; preserve `api_tab` and its active requests. Never restart/navigate the user's main tab to repair an auth read. Revisit if the website changes session endpoints or account identity shape.
- Use site-selected model/effort labels and checked state. Astra belongs to Work; Chat and Work are not model names. Power labels and indices settle separately. Revisit on mismatched readback, never guess a slug.
- Work exhaustion switches to verified Chat settings before submission. After a submit attempt, switch if possible but do not replay that message automatically.
- Stage TUI updates while callbacks are active; validate candidate bundles and retain the working version on failure. Checkpoint private account-scoped state across process exits. Reopened queues pause.
- Treat a runtime update as a dependency-graph revision. Editing a statically imported child does not replace the copy held by an already loaded parent. Load coupled runtime modules with one composite content revision; let an in-flight operation keep its graph and bind the next operation to the new graph. Compare recorded source hashes when live behavior disagrees with a fresh-process probe.
- Keep a single archive writer. A live daemon PID or missing log entry alone cannot prove a lock is stale. A dead PID or matched completed operation is required before cleanup.
- Preserve raw archive data and gaps separately. Hash integrity, download success, catalog closure and full product parity are four different claims.

## 3. Dead ends

- Extending every timeout: hides stuck page fetches and accumulates unfinished calls.
- Restarting Arc for an auth read: risks the user's working tabs and does not establish why the request hung.
- Retrying all sends after connection errors: duplicates billable or meaningful actions when submission succeeded.
- Treating all menu radio items as models: incorrectly captures Chat/Work navigation.
- Reading power text immediately after an arrow: index and label can disagree during rendering.
- Declaring media catalog complete from downloaded count: live gallery and bootstrap counts differ.
- Merging full thinking state and its delta into the same TUI message: duplicates detail text.
- Treating an unsemantic “Worked for 16s” div as expandable: guarded live clicks showed no detail panel; mark it non-expandable.
- Trusting only macOS filesystem watch events: rapid edits can be coalesced; compare source fingerprints as a fallback.
- Assuming a source edit refreshed transitive static imports in the daemon: the parent module can reload while retaining an older cached dependency. Verify the loaded graph revision or source hashes before interpreting a daemon/fresh-process divergence as website drift.

## 4. Symptom-keyed playbooks

### `Browser session timed out`

1. Do not resend the user's prompt.
2. Read `chatgpt monitor events --limit 60 --json` and match operation start/error timing.
3. Use `chatgpt chat reconcile --conversation CHAT_ID --json` to inspect the current website conversation. This does not navigate or send — but it does read the live page, so it needs a running browser and is refused while the account is frozen. Under a standing stop order, prefer `chatgpt conversations cached` and the operation receipts.
4. If the error is the identity read before the submit boundary, report NOT_SUBMITTED and restore the original draft/files.
5. Repair the bounded auth read (5-second fetch, 7-second CDP wait). Install a replacement `session_tab` only after it returns the expected user. Preserve the old session tab if validation fails, and always preserve the bulk `api_tab`.
6. Test repeated read-only identity calls, then one explicitly designated integration prompt. Do not use the user's unanswered prompt as a probe.
7. Reconcile the TUI after recovery. Preserve unresolved local drafts separately from website messages.

### `OUTCOME_UNKNOWN` after submit

Inspect the request receipt and current website messages. A completed receipt with matching request ID is positive evidence. Absence from one DOM snapshot is not evidence of non-submission. Leave replay blocked while uncertain. A pending request must not become an automatically sent queued draft after reload.

### Work usage exhausted

Accept a visible usage notice outside conversation prose, or selected Work plus the website's zero-remaining Work meter. Switch to Chat and verify the mode. Read Chat's actual selected model and effort; clear incompatible Work selections. If already submitted, do not copy the message into a second chat automatically.

### Model or effort readback differs

Capture the current picker controls. Distinguish root menu from model submenu. Wait for both power index and label to settle after each key. On discovery or invalid selection, restore the confirmed original position. Fail visibly if restoration cannot be confirmed.

### TUI update missing or broken

Keep the current renderer. Build a separate revision, validate its export, and request state handoff. Use source fingerprints if no watch event arrives. Active RPCs defer view handoff. Ctrl+Q checkpoints and detaches the client; it must not call chat.stop unless the user requested stopping generation.

### Archive lock with no progress

Run `chatgpt takeout watch-status --json` (local disk; works without the daemon and while frozen). A current rate deadline means wait. A live writer with incomplete event evidence means uncertain/stalled, not permission to unlink. Read current and rotated event logs. Never start a second writer.

**Never remove a lock file by hand.** Only `takeout watch-status` reporting `state:"stale-lock"` says
anything about that lock, and the recovery code re-validates it immediately before removing it itself.
An old timestamp, a missing log line or an unreachable daemon is not evidence of staleness. Submitting
a resume is a live bulk crawl (up to 1,063 conversation-detail reads, 5 s apart) and needs the account
owner's word in the current conversation, separately from any lock finding.

### Daemon appears dead or a send reports `Browser worker is closing`

Treat a process check as alive, dead, or unknown. Only `ESRCH` proves dead; `EPERM`, inaccessible health, invalid identity, or disagreeing owner files do not authorize replacement. Read authenticated loopback health with ordinary local permissions. Never use launchd kickstart to repair a live daemon during a send. A send interrupted after the submit boundary stays unknown; reopen the exact conversation, reconcile without replay, and follow the website response read-only. Generation-tagged locks prevent an old daemon shutdown from deleting a newer daemon's ownership files.

### Website body contains a reply that `snapshot.messages` omits

Compare the mounted message containers and the response turn wrappers in the actual DOM. Do not conclude no answer exists from one selector. Retain confirmed history across a virtualized suffix by matching stable message IDs; preserve unmounted earlier content and local uncertain drafts separately. Add a fixture for the actual observed layout, reload the parser, then prove the exact missing answer appears in both CLI snapshots and the running TUI. An active site control is not evidence that the transcript parser is complete.

### Media recording or download looks successful but is unusable

Verify MIME, bytes, sequence and content hash. Preserve partial files on failure. Ordered WebM chunks need their first header; do not silently drop buffered chunks. `audioDetected:false` is not successful voice reception. An arbitrary link in answer prose is not an owned downloadable attachment. CLI JSON-output handling must not overwrite the binary artifact.

## 5. Risk register and 12-step game tree

Likelihood is qualitative. Each cell includes its signal and pre-approved response; all branches inherit the impact column.

| Step | Likelihood / impact | Success branch | Loud failure branch | Partial success that could mislead |
| --- | --- | --- | --- | --- |
| 1 Load account | low / cross-account data | Expected id/user/workspace: continue | Identity mismatch: stop account operations | Valid session for other user: reject promotion |
| 2 Read auth | high / blocked sending | Bounded authenticated receipt: continue | Deadline: recover read-only tab | Caller times out, page fetch remains: abort fetch, do not accumulate |
| 3 Open conversation | medium / wrong destination | Exact URL and loaded messages: continue | Redirect/timeout: no submit | Same title, different id: require exact id |
| 4 Select mode | medium / quota or wrong workflow | Checked requested mode: continue | Missing control: preserve state | Click succeeds without selection: do not update header |
| 5 Select model | medium / wrong model | Exact checked label: continue | Missing model: show observed options | Chat/Work radios mistaken for models: reject mode rows |
| 6 Select effort | high / wrong effort | Settled position and label: continue | Timeout: restore original | Index changes before label: continue observation, not confirmation |
| 7 Attach media | medium / incomplete prompt | Files staged and website send enabled: continue | Upload failure: preserve draft/files | Some attachments missing: report unresolved inclusion; never claim all sent |
| 8 Submit | medium / duplicate message | Website user message observed: submitted | Pre-submit failure: restore draft | Click/transport ambiguous: retain one unknown attempt, block duplicate |
| 9 Stream reply | medium / lost output | New reply text/activity: stream | Site error: preserve partial text | Old thinking or full+delta duplicates: scope current turn and consume once |
| 10 Queue follow-up | medium / unintended send | Local queued marker, ordered drain: continue | Failed reply: pause queue | Reload drains uncertain work: restore queue paused and require resolution |
| 11 Update/quit | medium / lost draft or hang | Valid revision/checkpoint: restore | Syntax error: retain old view | Quit restores terminal but RPC keeps process alive: detach client only |
| 12 Archive/receive media | high / false completeness | Hashes and scope receipts: report exact coverage |429/integrity failure: checkpoint/backoff | All downloaded but catalog incomplete: preserve gap, refresh on resume |

Premortem: the client would be abandoned if it repeatedly guessed submissions, allowed background archives to starve interactive work, lost drafts on updates, or claimed exhaustive coverage from a fixed menu. Guards are phase-aware receipts, bounded independent authentication, private checkpoints, single-writer recovery and explicit coverage gaps. Interactive/background contention remains a required live test, not a solved assumption.

Red-team recheck: account transitions, cancellation after send, browser/tab closure, malformed source updates, stale UI refs, server quota warnings, pending uploads, clock/lock ambiguity, output-file overwrite, gallery count mismatch and missing thinking semantics are covered by separate branches. Do not collapse them into “retryable”.

## 6. Invariants and verification

- No API/Codex credentials: browser session is the authentication boundary.
- No blind write retry: test chatgpt-receipts and submission-phase tests.
- Harness protocol frames execute only when an exact, complete run-bound tag appears at line start in assistant prose. Opening tags inside fenced code, inline code or blockquotes are inert; parser fixture coverage does not by itself prove live website streaming behavior.
- Unknown UI surface cannot fall back to main: test chatgpt-browser-safety.
- Confirmed selection only: test chatgpt-model-controls plus live observed options.
- Private persistence and paused restored queue: test chatgpt-tui-session and chatgpt-tui-reopen.
- Retain last good renderer: test chatgpt-tui-reload; repeat only on changed code or a failure.
- Harness agents use owned auxiliary tabs. Opening or selecting a child must not make a streaming parent document hidden. Visibility emulation must be verified independently from animation-frame health; a healthy `requestAnimationFrame` sample does not prove that a hidden parent continues streaming.
- Binary correctness: test chatgpt-audio-capture, chatgpt-media and actual playable media.
- One archive writer: test chatgpt-takeout-supervisor and inspect active lock/operation receipts.

Run from APIPlan: `bun test test/chatgpt*.test.ts src/chatgpt/*.test.ts`. Filesystem/PTY fixtures need their ordinary local permissions. The live acceptance gate for this incident is three bounded successful identity reads, a designated test send/receive, no duplicate website user message, and recovered TUI state. Offline success alone cannot close the incident.

Known knowns: screenshot timings, pre-submit identity ordering, independent recovery session tab, completed media export, no duplicate website text. Known unknowns: exact reason auth fetch hung, background contention, all native queue/steering controls, complete multimodal parity. Previously unwritten facts: power labels lag indices, Work/Chat menus overlap, ordinary activity divs can be non-interactive. Unknown unknowns: retain drift snapshots, classify by phase, report a divergence before executing a speculative recovery.

## 7. Escalation contract

Stop the affected mutation when identity differs, a submit outcome is uncertain, a menu cannot verify restoration, or a writer lock cannot be proven stale. Continue independent reads and tests. Report the exact symptom, phase, timestamps/request id, observed website state, attempted playbook and remaining uncertainty.

On self-authorization (clarified 2026-09-16, because the earlier wording read as a blanket licence):
**nothing that reaches chatgpt.com is ever self-authorized.** "Do not demand another user confirmation
for already-authorized reversible repair" covers **local, reversible** repair only — rewriting local
state, re-reading a receipt, restarting a local parse. A send, a catalog page, a settings write, a
share click, a takeout run, a thaw: each needs the account owner's word in the current conversation,
every time. Never guess a destructive recovery.

## 8. Field log

- 2026-09-15: three 45-second auth-read failures appeared as unknown sends. Source ordering and a live main snapshot establish that these attempts never reached submit; generic timeout classification was wrong.
- 2026-09-15: model root/submenu overlap and asynchronously changing effort labels broke immediate selection despite fixture success. Explicit root discovery and settled transitions produced verified Astra/Work and Chat power lists.
- 2026-09-15: Work zero-remaining meter produced a verified automatic transition to Chat/Latest/Pro without a test prompt.
- 2026-09-15: two-process PTY verified private conversation/scroll/draft/file restoration and paused queue; the old version's unsaved exact terminal scroll cannot be reconstructed.
- 2026-09-15: the refreshed incremental media export reached 248 current targets with 249 stored files, zero failures, zero remaining targets, hash integrity true and download completeness true. The extra stored file is a retained 4,898-byte historical version absent from the refreshed target set. Catalog closure remains false: the bootstrap scalar was 120 while the same-window catalogs yielded 124 unique gallery assets and 129 unique assets across gallery and image-library scopes. Do not turn binary completion into catalog completeness.

- 2026-09-15: final auth repair passed three healthy live identity reads; an isolated Actions send/receive completed in 14.4 seconds. A fixture verifies bulk requests survive session-tab recovery. Full service/journal submission fixtures passed; the user's post-fix live TUI retry remains unobserved.
- 2026-09-15: voice start returned requested while the visible Start Voice button remained unchanged. A click receipt cannot establish an active voice session; require site-state evidence before reporting started.

- 2026-09-15 13:50Z: restricted PID liveness was misread as dead; a launchd restart interrupted a new send. The replacement daemon was also wrongly called dead until an unrestricted authenticated health check proved it alive. Record EPERM as unknown, never dead; no further restarts were made. The website contains the submitted question and TUI read-only recovery hotloaded without restart.
- 2026-09-15 13:56Z: current site body contained assistant output missing from the `[data-message-author-role]` transcript selector. Earlier confirmed turns were also unmounted. Parser layout coverage and virtualized history require distinct fixes; a green transport check cannot certify the rendered conversation.
- 2026-09-15: live Voice input and non-silent remote WebRTC output verified (47,102 bytes, 103 ordered chunks); capture cleanup restores prototype hooks/listeners and preserves the website's remote tracks.
- 2026-09-15: archive catalog already had 1,055 IDs while coverage only contained 797 attempted detail entries. Persist the observed target set and seed pending entries before the first detail read; early 429 must not hide unattempted targets.

- 2026-09-15 14:09Z: the original interrupted conversation completed on the website and in the live TUI: 16,704-character assistant response with a real message ID, no error banner, inFlight false, one preserved unresolved draft. No message was replayed. An independent full-service test chat verified one submission, five streamed updates and the expected reply in 15.817 seconds. Final integrated suite: 211 passed, 0 failed, 716 assertions across 51 files. This closes the reproduced incident, not global feature parity.

- 2026-09-15 harness diagnosis: the first daemon-backed harness stream truncated, while a fresh synthetic probe returned the full expected 143-character start/end sequence through streaming. `runtime.json` recorded different hashes for the cached and freshly loaded `Actions` implementations, proving a stale loaded dependency for that comparison; it does not prove a website streaming fault.
- 2026-09-15 harness diagnosis: on the second live attempt, the parent emitted a complete `agents.create` frame and the broker spawned `alpha` during the parent stream. Opening the child changed the parent document to hidden and the parent text then stalled. A blank-tab focus emulation changed that document from hidden to visible without bringing it to the front. Animation-frame sampling was already healthy, so `requestAnimationFrame` starvation is not supported. The observed ordering identifies an owned-tab visibility collision; the owned-tab emulation repair and the full six-parent-turn live proof remain pending.
- 2026-09-15 harness protocol repair: a semantic DOM replacement temporarily split a tool closing tag before the final snapshot restored the exact frame. The broker previously routed that transient parse error as a tool result and could still mark the turn complete; it also accepted a final reply that silently omitted an already-dispatched call. Each replacement is now parsed from fresh state, transient syntax errors remain provisional, and the final semantic text must parse cleanly and contain every dispatched call with the same payload. A malformed, omitted or revised final call fails the turn and cannot enqueue an automatic repair turn.

### 2026-09-16 safety pass

- Added the freeze switch (`chatgpt freeze` / `thaw` / `freeze status`, `/freeze` / `/thaw`, ❄ FROZEN
  header) and direct mode (`CHATGPT_DIRECT=1`) to this oracle's §0, and to the quickstart.
- Live on his account, from `events.jsonl`: `freeze.set` at 2026-09-16T06:25:30.237Z with reason
  *"resumed after his STOP; site traffic stays off until he says go"*; a frozen `status` completed in
  17 ms at 06:25:50.989Z with no browser; `conversations.list` was refused at 06:26:01.865Z with
  `code:"FROZEN"` at `browser.start`, message *"no request was sent"*; `freeze.status` answered in 1 ms.
  That is live evidence of the gate refusing traffic — it is **not** a live test of any website
  behaviour, and no site request was made to obtain it.
- `test/chatgpt-freeze.test.ts` (child process, isolated `CHATGPT_HOME`) covers flag durability, the
  allowed-op set, the unforgeable `Symbol`, the refused browser launch, frozen `status`, Stop while
  frozen, and `autoResume:false`. Fixture evidence only.
- Corrected in this document: the stale-lock line (it read as permission to unlink), and the
  escalation contract's self-authorization sentence (it read as permission to self-authorize site
  traffic). Corrected in the quickstart and slash inventory: `chatgpt status` is live unless frozen,
  a bare `chatgpt takeout` is the 1,063-conversation crawl, `--original` is irreversible, `settings set`
  and `conversations share` are real writes, and `api request` accepts any method on any backend path.

### Note to the next executor

The place I trust least is the gap between an apparently healthy daemon and a page fetch that never settles. The screenshot is better evidence than a green fixture suite. First establish which phase failed and which browser tab owns it; then compare the user's actual website conversation before touching a send button. Keep the draft safe and the uncertainty visible. — Codex, 2026-09-15
