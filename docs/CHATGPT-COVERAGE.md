# ChatGPT website client: capability coverage

Updated 2026-09-16 (safety pass). Recovery milestone from 2026-09-15 14:12Z: the original response completed in the live TUI (16,704 characters, confirmed website ID, no error); an isolated full-service send/receive passed in 15.817 seconds.

**The suite number is fixture evidence, not a health claim.** "211 passed, 0 failed" was one dated
offline run on 2026-09-15; it proves the fixtures agreed with the code that day. It does not mean the
client works, and it never did: this project's most expensive misreading was a green suite while the
user's TUI was visibly broken. A later sandboxed run recorded in the wargame notes reported 243
passed / 13 failed / 2 errors, the failures being PTY and daemon-lock tests the sandbox denies. Always
write "fixture verified" or "live verified" — never a bare "verified" — and re-run before quoting a
number.

**Everything in this matrix is a capability record, not a permission.** The account is real and
personal, it is frozen on purpose (`chatgpt freeze status`), and a "Live verified" cell means someone
once did that with the owner's consent — not that it may be repeated. Read
[the quickstart's cost index](CHATGPT-QUICKSTART.md) before running anything listed here.

Read with `CHATGPT-ORACLE.md`, `CHATGPT-PLAN.md`, and `CHATGPT-ARCHITECTURE.md`.

This matrix distinguishes four kinds of evidence:

- **Implemented**: a typed service/CLI path exists.
- **Live verified**: the intended account produced the stated semantic result.
- **Fixture verified**: tests exercise the path without proving current website behavior.
- **Open**: the concrete observation or operation still missing.

An operation receipt marked `complete` proves that a dispatcher returned. It does not, by itself, prove that a product action reached the right object or that a paginated catalog is exhaustive. This document therefore does not derive parity from `capabilities.list` or generic browser dispatch.

## Current account snapshot

All counts below are account-scoped and omit private IDs.

| Scope | Durable evidence | Exact open gap |
| --- | --- | --- |
| Conversation catalog | The refreshed observed target set contains **1,063 IDs**, persisted with a validated SHA-256 hash; all **1,063/1,063** have coverage entries. Source catalogs report complete. | Full trees are a separate gate; the earlier 258 uninitialized targets are now tracked. Counts may grow as chats are created. |
| Conversation trees | Current active-writer checkpoint has **244 complete** and **819 partial** among **1,063** tracked conversations. | Capture and structurally validate the remaining 819; server cooldown currently limits progress. |
| Takeout bundle | **266 files**, **1,081** coverage entries, manifest incomplete. | **824 required incomplete** entries: 819 trees plus tasks/plugins/connectors/pins/capabilities. |
| Takeout worker | At 14:33Z the existing daemon/writer was positively alive and active. Checkpoint refreshed at 14:32Z; server 429 renewed cooldown until **14:47:28Z**. No restart or second writer. | Wait for the existing writer; archive completion is unproven. Target-seeding promotion is now live verified. |
| Projects | **1** project catalogued; its **4** chats captured; project and project-chat pagination marked complete. | Project mutations and project file/instruction/sharing behavior lack semantic live proof. |
| Owned GPTs | Owned GPT catalog completed with **0** rows. | A zero-row account cannot prove get/edit/publish/delete behavior. |
| Media export | The fresh **248/248** target set has **786,531,523 bytes**, **0 failures**, and a passing hash audit. The store retains **249** verified files / **786,536,421 bytes** because one 4,898-byte prior version absent from the fresh catalog remains as historical evidence. The incremental run reused 233 matching targets and fetched 15 new references. | Binary integrity is complete for every target in the 14:47–14:48Z catalog. Overall catalog completeness remains false because bootstrap membership is opaque. |
| Gallery catalogs | One bounded live capture terminated every observed cursor: root library 172 rows/9 pages, image library 53/3, generated 103/3, images-app uploads 22/1, archived 0. Gallery arithmetic is exact: 103 generated + 22 uploads - 1 overlap = **124** unique; adding 53 library images with 48 overlaps = **129** cross-catalog IDs. | Bootstrap still reports **120** but exposes no member IDs, so its membership cannot be reconciled. The earlier **128** was correct for its saved snapshot: one generated ID later appeared in the library without changing the union, while one new library-only, owned 40,027-byte PNG in `created` state raised the union to 129. |
| Settings map | All **17** top-level sections navigated; **50** nested surfaces recorded. Keyboard now has **14** scoped shortcut-editor surfaces mapped read-only. | **103** controls/surfaces remain unexplored, mainly Analytics 23, Keyboard 15, Voice 11, Plugins 10, Security and login 9, and Personalization 7. Live write controls were intentionally not exercised. |

## Capability matrix

| Capability | Implementation | Strongest live verification | Fixture/offline verification | Exact gap |
| --- | --- | --- | --- | --- |
| Account identity and attached browser | Account selection, status, bounded dedicated `session_tab`, attached and managed browser adapters | The dedicated auth tab recovered once and then returned three consecutive healthy authenticated reads; the attached Arc session remained on the expected account | Session recovery, safety and adapter tests | The auth gate, full-service send/receive, and live TUI response recovery are verified for this incident. Managed-profile migration and non-Chromium browsers are unverified. |
| Conversation catalog and cache | Active/archived pagination, SQLite cache, list/get/path/search/open/export | 1,055 active and 0 archived rows fully paginated in both the private store and saved takeout index | Catalog, import, snapshot and core suites | Persist an explicit target-set hash and initialize every observed row before detail fetches. Search relevance and every returned branch shape have not been exhaustively compared with the website. |
| Conversation tree capture | Raw fetch, structural validation, hashed files, resumable manifest and target-seeding before detail reads | **1,063 observed targets** have a valid target-set hash and **zero missing coverage entries**; 244 trees complete at 14:33Z | Takeout and supervisor suites verify target seeding and preservation | 819 trees remain partial under rate limiting. Source catalog closure and local hash integrity do not certify every tree. |
| Send, stream, stop and reconcile | Phase-aware receipts, pre-submit classification, streaming, stop and read-only reconcile | Original user response recovered with real website identity and 16,704 characters in the TUI, error cleared. Separate full-service send completed in 15.817 seconds with one verified submission and five streamed text updates | Submission, receipts, actions, thinking and recovered-active PTY suites | Original uncertain local draft remains separate and was never replayed. General website changes and every possible response tool are not exhaustively certified. |
| Mode, model, effort and Work fallback | Menu discovery, checked-state selection, settled effort labels, Work exhaustion transition | Astra/Work and Chat model/power menus observed; Work zero remaining switched to Chat/Latest/Pro with verified readback | Model-control and Work-usage suites | Other currently exposed combinations are not live-matrix tested. Menu drift and label/index settling remain website-change risks. |
| Stop control and direct mode (2026-09-16) | Durable `freeze.json` flag per account; refusal gates in `BrowserWorker.start`/`call`; `freeze.set`/`freeze.status` operations; frozen-aware `status`; `chatgpt freeze`/`thaw`/`freeze status`; `/freeze`, `/thaw` and the ❄ FROZEN header; `CHATGPT_DIRECT=1` in-process execution of `DIRECT_READ_OPERATIONS` | On his account (`events.jsonl`, 2026-09-16): freeze set at 06:25:30.237Z, frozen `status` answered in 17 ms with no browser, `conversations.list` refused at 06:26:01.865Z with `code:"FROZEN"` at `browser.start`, `freeze.status` in 1 ms. The refusal path is live-observed; no site request was made to observe it | `test/chatgpt-freeze.test.ts` (isolated `CHATGPT_HOME`, child process): durability, allowed-op set, unforgeable `Symbol`, refused launch, frozen `status`, Stop while frozen, `autoResume:false` | Not exercised: freeze arriving mid-generation on the live site, thaw-then-resume on a real run, and a launchd respawn observed while frozen. The flag is account-scoped: freezing `default` does not freeze another account id |
| Conversation management | Rename, pin/unpin, archive/unarchive, share launcher, edit/branch/regenerate paths | Rename/restore, pin/unpin and archive/unarchive were exercised **once, on one dedicated integration chat**, with exact-row checks, and restored afterwards | Conversation-action tests cover edit/branch/regenerate mechanics | Edit/branch/regenerate lack a documented live semantic postcondition. Share clicks the launcher and returns `shared:false`; publishing is unverified. **`unshare` is routed but not implemented** — `ConversationActions.manage` has no `unshare` label and throws before clicking, so a share cannot be revoked from this client. Delete, move-to-project, report, feedback and read-aloud are not implemented. |
| Projects | List/get/chats and project-aware conversation access | One project and four chats fully captured | Project parsing and service tests | Create, rename, delete, instructions, files, sharing, memory configuration, and move-chat operations are not covered end to end. |
| GPT discovery and ownership | Discover and owned-list paths; GPT descriptors | Owned list completed with zero rows; discovery returned live data | GPT service/tests | Get/edit/create/publish/delete, knowledge files, actions, and version history need an owned fixture or dedicated test GPT. |
| Account data, models, voices, tasks, plugins, connectors and pins | Dedicated list/get operations and takeout capture; task-specific cursor reader handles task_id, preserves all raw pages and explicit termination | Account/features/models/voices captured. New task reader decoded the actual saved website response: 2 tasks, explicit terminal cursor, every field retained | Task pagination tests cover continuation, missing IDs, repeated/conflicting cursors, counts, budgets and network errors | Task adapter has not yet refreshed the live archive. Plugins/pins/capabilities closure and connectors access remain open; task mutation semantics are separate. |
| Settings and instructions | Settings read/map, instruction read, guarded settings write | Settings, instructions and 17-section navigation captured; one no-op settings receipt completed. Keyboard's 14 repeated shortcut launchers were uniquely scoped and opened without entering a key. | Settings mutation tests use fixtures | No live setting value was intentionally changed. 103 nested/control gaps remain, including 14 Keyboard toggles and one disabled Keyboard reset that require fixture evidence. |
| Media discovery and export | Library, image-library, generated, uploads and archived catalogs; resumable download; content-addressed manifest; hash audit; raw captures now retain bootstrap plus each page's input cursor and request start/end time | The fresh capture explicitly terminated root 20×8+12, image 20+20+13, generated 35+48+20 and uploads 22; its 129 image IDs have exact membership buckets. All 248 fresh download targets are present and hash-valid | 20 media tests and the takeout integration test pass; provenance tests cover bootstrap, cursor input and page timestamps | Bootstrap's scalar 120 still has no inspectable membership, so `catalogComplete` remains false even though `downloadComplete` is true. Folders/archived are account-conditional, and trash/version history remain unmapped. |
| File upload and generated-image actions | Upload plumbing and media extraction exist; generated results are discoverable | A prepared text attachment was read by ChatGPT and produced the exact `FILE_UPLOAD_OK` response. A generated PNG was resolved and saved as a valid 717,667-byte file; 103 generated-image and 22 upload rows are catalogued | Multimodal and media fixtures | Image generation itself was observed through ChatGPT rather than a dedicated typed create operation. Live image edit, version history and a fresh typed upload/create/download chain remain open. |
| Dictation, audio and voice | Input injection, dictation start/stop/transcribe, output capture/play/status, voice start/stop and voice listing | A 2.69-second synthetic fixture produced the exact live website transcript “This is a terminal dictation integration test.” with HTTP 200 and `submittedToChat:false`. A separate explicit-fixture Voice session verified session/input use/input end and captured 103 remote WebRTC chunks: 47,102-byte Opus, 48 kHz stereo, 30.47 seconds, `audioDetected:true` | Audio input, output, capture, multimodal and live-voice tests | Dictation and remote voice audio are semantically live verified. The earlier WebAudio-only digital-silence capture is retained as negative evidence. Camera, screen share and video paths remain incomplete. |
| Thinking details | Thinking-state parsing and guarded expansion | A live “Worked for 16s” element was observed and correctly treated as non-expandable | Thinking parser/merge tests | No live expandable reasoning panel with semantic detail has been captured; generic `thinking.expand` completion is insufficient. |
| Billing and invoices | Billing discovery, Stripe invoice enumeration/PDF download, local import/dedup, periodic watcher | One real invoice was paginated, downloaded from Stripe and imported; watcher is configured for six-hour checks | Invoice and watcher suites | Other billing states/accounts, failed-payment flows and long-run watcher delivery have not been observed. |
| TUI session, drafts and local queue | Persistent session state, drafts/files, paused restored queue, reload handoff, detach | The live checkpoint recovered the completed original response, cleared the error, restored an ID-anchored historical prefix, and retained one unresolved draft separately; no replay occurred | Two-process PTY suites verify conversation, scroll, draft/file restoration and paused queue | The queue is local, not ChatGPT’s native steering/queue. ID-anchored previous observations preserve known history; this is explicitly partial coverage and cannot reconstruct unobserved turns or the full branch tree. Exact terminal scroll from an older version cannot be reconstructed. |
| Browser maps and surface primitives | Open/activate/close, snapshot, click/type/evaluate/request, surface locks and API-tab routing | Main/API surface reads and browser-open/close operations have run | Browser-safety, browser-session, flows and snapshot suites | `snapshot.messages` enumerates only currently mounted `[data-message-author-role]` elements. In the same conversation, an older snapshot had five IDs while the newer snapshot had three: two IDs were the retained suffix, three older IDs were unmounted, and one new user ID appeared. This is consistent with DOM virtualization, not proof of deletion; no cached full tree exists yet for independent confirmation. |
| Health, apps, library, sites and advanced tools | Some routes are reachable through browser primitives and generic capability discovery | No capability-wide semantic live proof | Dispatch and shape fixtures only | Dedicated operations for app install/configure, advanced Library management, Sites publishing, scheduled-task mutation, agent/canvas/camera workflows and many menu-only surfaces remain incomplete. |

## Settings gap concentration

The current settings capture is navigation-complete and action-incomplete. The largest unexplored buckets are:

| Section | Controls observed | Nested surfaces recorded | Unexplored |
| --- | ---: | ---: | ---: |
| Keyboard | 29 | 14 | 15 |
| Analytics | 23 | 0 | 23 |
| Voice | 13 | 2 | 11 |
| Plugins | 14 | 2 | 10 |
| Security and login | 15 | 1 | 9 |
| Personalization | 23 | 7 | 7 |
| Billing | 6 | 0 | 5 |
| Account | 7 | 1 | 5 |

The remaining 18 unexplored entries are spread across General, Data controls, Usage, Storage, Safety, Parental controls, Trusted contact and Cloud browser. Notifications has 10 nested surfaces and zero unexplored entries in the current capture, but its write semantics are still not live verified.

## Three highest-value atomic next actions

1. **Continue the existing archive writer.** Target-seeding promotion is verified: 1,063 targets, valid hash, zero absent coverage entries. At 14:33Z, 244 complete trees and 819 partial remain. Observe the next checkpoint after its 14:47:28Z cooldown; do not restart or duplicate the writer. Adopt the new task pagination reader on the next account capture.
2. **Resolve or formally bound bootstrap membership semantics.** The same-window catalogs and 248-target export are complete and hash-valid. Determine whether an observed endpoint can identify bootstrap's 120 members without downloading binaries; otherwise retain 120 as an opaque scalar and keep the exact 124-gallery/129-cross-catalog set evidence as the durable boundary.
3. **Map the next largest read-only settings gap.** Inspect Analytics on a dedicated settings surface without activating write controls. Keyboard's 14 repeated launchers are now mapped; its remaining 15 controls are writes (14 toggles plus disabled Restore defaults) and require fixture evidence.

## Claims that are safe today

- The fresh 248-target media export is byte-complete and hash-valid; one absent prior version is retained separately as historical evidence.
- Conversation, project, settings, billing, model and voice data have real account-scoped captures; synthetic dictation, file upload and a generated-image download have semantic live evidence.
- The takeout can checkpoint, back off on 429, and recover under a single-writer supervisor without blind lock clearing.
- The CLI/TUI has broad implemented surface area and meaningful fixture coverage.
- Site traffic can be stopped durably and locally: the freeze flag survives daemon restart, local reads keep working, and the website Stop control stays reachable while frozen.

Global ChatGPT parity, exhaustive media discovery, a complete conversation archive, native queue/steering parity and full multimodal behavior remain open.
