# ChatGPT website CLI quickstart

Use your signed-in ChatGPT website account from a standalone terminal workspace or scripts. This client uses its own browser session, separate from APIPlan’s OpenAI provider and Codex credentials.

## Read this first: it drives a real, signed-in account

Every command on this page that is not marked *local* runs inside the account owner's own logged-in
ChatGPT session. Sends spend his quota. Writes change objects he owns. **Nothing that reaches
chatgpt.com can be recalled**, and this client implements no undo for any of it.

> 🛑 **THE ONE RULE**
> If a command is not in the *safe while frozen* list below, assume it reaches chatgpt.com, and run it
> only when the account owner asks for **that exact command, in the current conversation**.
> "It is only a status check", "just to test that it works", "the documentation lists it", a doc
> example, and a previous permission for a different command are **not** permission.

Every command that costs requests is marked below with a 🛑 block naming what it does, how many
chatgpt.com requests it costs, whether it is reversible, and that it needs the owner's word.

### The stop control: `chatgpt freeze` / `chatgpt thaw`

Added 2026-09-16. Freeze is the switch to reach for **before** anything on this page, and the switch
that makes a mistake survivable.

```sh
chatgpt freeze --reason "why site traffic is off"   # stop all site traffic now
chatgpt freeze status                               # is it frozen, and why
chatgpt thaw                                        # allow site traffic again (owner's decision only)
```

| Fact | Detail (verified in `src/chatgpt/freeze.ts`, `transport.ts`, `service.ts`, `bin/chatgpt.ts`, `tui.ts`) |
| --- | --- |
| One durable flag | `~/.apiplan/chatgpt/accounts/<id>/freeze.json`, written atomically. It is a file, not process state, so it **survives daemon restart, launchd respawn and reboot**. |
| Refreezing is idempotent | A second freeze keeps the original `at` and `reason`; `thaw` records `thawedAt`. Both write a `freeze.set` / `freeze.cleared` event to the account event log. |
| Two gates, one choke point | `BrowserWorker.start()` refuses to launch a browser while frozen, and `BrowserWorker.call()` refuses every worker operation that is not activity-reducing. Everything that touches the site goes through that class. |
| Error contract | Code `FROZEN`, `retryable:false`, message ending `no request was sent`. |
| Allowed while frozen | Only operations that observe or *reduce* activity: `status`, `close`, `surface.close`, `audio.output.stop`, `audio.clear`, `request.info`, `network`, `snapshot`. |
| Stop still works | The website's own Stop control can still be clicked while frozen. That bypass is an in-process `Symbol` (`ALLOW_WHILE_FROZEN`); a Symbol cannot be expressed in JSON, so a daemon RPC payload, a slash command or website text can never forge it. |
| Local reads keep working | Cached index, search, receipts, monitor events, takeout status/audit/watch-status and queue state all keep working while frozen. |
| Frozen `status` is local | While frozen, `chatgpt status` skips the identity fetch and reports `frozen`, `browser:{running:false}`, `session:{skipped:"frozen"}` without starting anything. |
| TUI | `/freeze [reason]` and `/thaw`; a frozen account shows **❄ FROZEN** in the header. `/freeze` writes the flag in the TUI process itself (no daemon required) and clicks Stop if a generation is running. The header re-reads the flag from disk every 5 s, so a freeze from another terminal appears in a running TUI. |

> 🛑 **`chatgpt thaw` is never an error-recovery step.**
> When a command fails with `code:"FROZEN"`, the switch did exactly its job. That error's own `action`
> field says *"Run `chatgpt thaw`…"* — **do not follow it.** Thawing is the account owner's decision,
> asked for in his own words. Report the `FROZEN` error and stop.

Live evidence on the primary account (`events.jsonl`, 2026-09-16): a frozen `status` completed in
17 ms with no browser at 06:25:50.972Z, and 11 seconds later a real `conversations.list` was refused
with `code:"FROZEN"` at `browser.start`. The unit suite (`test/chatgpt-freeze.test.ts`, run in an
isolated `CHATGPT_HOME`) covers flag durability, the allowed-operation set, the unforgeable Symbol,
the refused browser launch, frozen `status`, and Stop-while-frozen. Those are fixture results, not
live-website results.

### Direct mode: local reads with no daemon and no browser

```sh
CHATGPT_DIRECT=1 chatgpt conversations cached
CHATGPT_DIRECT=1 chatgpt freeze --reason "stop now"
CHATGPT_DIRECT=1 chatgpt freeze status
```

- `CHATGPT_DIRECT=1` runs the operation **in-process**: no daemon is started, no browser is launched.
- The same in-process path engages **automatically** when the daemon is unreachable (for example a
  sandbox that denies loopback TCP), so freeze/thaw and local reads keep working when nothing else does.
- It runs only `DIRECT_READ_OPERATIONS` (`src/chatgpt/service.ts`): `online.list`, `online.status`,
  `receipts.list`, `receipts.get`, `conversations.cached`, `conversations.search`, `takeout.status`,
  `takeout.audit`, `takeout.watch-status`, `flow.validate`, `flow.status`, `capabilities.list`,
  `map.capabilities`, `adapter.get`, `adapter.validate`, `monitor.events`, `invoices.watcher`,
  `freeze.set`, `freeze.status`.
- Every other operation fails with `code:"DAEMON_REQUIRED"` and starts nothing.
- Direct mode builds the service with `autoResume:false`, so a local read can **never** wake the
  background archive writer.

> 🛑 **Do not follow the `DAEMON_REQUIRED` hint.** Its `action` text suggests starting the daemon with
> `chatgpt status`. On a thawed account `chatgpt status` launches the browser and hits the site
> (see below). A missing daemon is something to report, not to fix with site traffic.

### Safe while frozen (the only commands that need no fresh permission)

`chatgpt freeze`, `chatgpt thaw` (owner's word only), `chatgpt freeze status`, `chatgpt status`
*while frozen*, `chatgpt conversations cached`, `chatgpt conversations search`,
`chatgpt takeout status|audit|watch-status`, `chatgpt monitor events`, `chatgpt receipts list|get`,
`chatgpt capabilities list`, `chatgpt invoices watcher`, `chatgpt adapter get`,
`chatgpt online list|status`, `chatgpt queue list|status`, `chatgpt accounts list`, `chatgpt browsers`,
`chatgpt doctor`, `chatgpt tui --mock`.

`chatgpt takeout watch-status` is answered straight from disk by `bin/chatgpt.ts` without the daemon,
even outside direct mode.

### Cost index: every command on this page that reaches chatgpt.com

| Command | What it does | chatgpt.com cost | Reversible |
| --- | --- | --- | --- |
| `chatgpt api request --path … --method …` | Arbitrary authenticated backend call, any method, any `/backend-api/` path | 1 per call, unbounded in effect | **No** — this is the highest blast radius in the client |
| `chatgpt takeout` (bare) / `takeout run` | Bulk crawl of every conversation tree | Up to 1,063 conversation-detail reads, paced 5 s apart (819 still outstanding) | No — requests sent, quota spent |
| `chatgpt takeout --original` | Submits OpenAI's **official** account export | 1 irreversible request; he gets an email | **No** — cannot be recalled |
| `chatgpt takeout watch` | Arms a durable background writer that resumes the crawl on every later daemon start | The whole crawl, repeatedly, unattended | Only by `takeout unwatch` |
| `chatgpt chat send` / `chat new` / `queue run` / TUI Enter | Sends a real message | 1 send + generation | **No** — no unsend exists |
| `chatgpt settings set` | Changes his real ChatGPT settings | 1 write | Only by setting it back by hand |
| `chatgpt conversations share` | Clicks the share launcher on a private chat | 1 UI interaction | No working `unshare` exists |
| `chatgpt conversations rename\|pin\|unpin\|archive\|unarchive` | Mutates a chat he owns | 1 write each | Only by the inverse action |
| `chatgpt invoices download --all` / `sync` / `watch` | Bulk Stripe downloads, filing, background watcher | 1 listing + 1 download per invoice, then repeats | Imports are deduplicated, requests are not |
| `chatgpt media export` / `media download` | Authenticated asset downloads | Hundreds of MB; a 429 stops the run | No |
| `chatgpt login` / `browser start` / `chatgpt status` *(thawed)* | Launches the browser worker | 2 chatgpt.com tab loads, then an `/api/auth/session` fetch | Browser can be stopped; the page loads already happened |
| `chatgpt ui click\|fill\|key\|text\|mouse\|scroll\|upload` | Blind input into a live signed-in page | 1 interaction; whatever the control does | Depends entirely on which control was hit |
| `chatgpt conversations list --all` | Full catalog pagination | 11+ pages per scope at 1,063 chats, both active and archived | Read-only, but prime 429 material |

## Start

Local-only, no account contact — safe to run any time:

```sh
bun bin/chatgpt.ts setup
bun bin/chatgpt.ts doctor
bun bin/chatgpt.ts install
chatgpt tui --mock
```

Setup installs the pinned nodriver runtime through `uv`. Install creates the standalone shell shim.
`apiplan chatgpt …` delegates to the same client. Doctor checks local prerequisites only; it opens no
tab. `chatgpt tui --mock` runs entirely on offline fixtures.

> 🛑 **`chatgpt login` and `chatgpt status` are LIVE commands — owner's permission required.**
> **What:** `login` opens the account browser headed; `status` starts the browser worker and then reads
> the website identity.
> **Cost:** starting the worker opens **two chatgpt.com tabs** in the signed-in session
> (`src/chatgpt/browser.py` `init`), and `status` then fetches `/api/auth/session`. A signed-in page
> load fires many backend requests of its own.
> **Reversible:** the browser can be stopped afterwards; the page loads cannot be undone.
> **Rule:** `chatgpt status` is **not** a harmless read on a thawed account. `service.ts` excludes
> `status` from its no-start allowlist unless the account is frozen. For a genuinely offline picture
> use `chatgpt freeze status`, `chatgpt takeout watch-status` and `chatgpt conversations cached`.

```sh
chatgpt login     # live: opens the account browser
chatgpt status    # live unless frozen: starts the browser, reads website identity
chatgpt           # opens the TUI; the TUI itself starts nothing until you act
```

The daemon starts on demand: any command that is not a local read will spawn one and, through it, a
browser. The default account also has a verified macOS launchd job installed; `chatgpt autostart
status` reports its ownership and process state. The signed-in browser must still be available for
website operations.

> 🛑 **If a command reports `ChatGPT daemon did not start.`, stop.** Do not re-run it and do not
> "try again with different flags" — retries spawn more daemon attempts. Report the failure.

## TUI controls and live updates

On macOS, use **Option** for the shortcuts below. Other platforms use Alt.

Open `chatgpt tui`. One restart of older TUI versions installs the reload host; subsequent source updates are built and validated automatically. A failed build retains the working interface. Updates preserve the draft, transcript, verified selection, navigation and local queue. Updates wait for active generation, RPCs and nonportable overlays to finish.

| Shortcut | Action |
| --- | --- |
| Option+M | Select a model and apply it immediately; also switch between Chat and Work |
| Option+E | Discover the current model's website power levels and apply effort |
| Option+T | Expand/collapse captured website thinking details |
| Option+A | Attach local files to the draft; files travel with queued messages |
| Option+R | Review received media, download locations and available previews |
| Option+Q | Review the shared CLI/TUI queue: edit, remove, reorder, pause, run or reconcile |
| Up / Down | Move vertically through wrapped or multiline drafts; Up on the first visual row recalls sent prompts |
| Shift+Enter / Ctrl+J | Insert a newline; plain Enter sends |
| Ctrl+K | Find commands |
| Ctrl+C | Stop the current response or close an overlay |
| Ctrl+Q | Exit the workspace |

Up on the first composer row browses previously sent user prompts. Unconfirmed attempts, local drafts and queued messages are excluded. Down on the last row advances through history; after the newest prompt, it restores the original draft, attachments and cursor. Recalled prompts are editable copies. Vertical movement preserves the preferred column across wrapped lines and Unicode graphemes. The composer grows to six visible rows; longer drafts scroll with the cursor. Bracketed multiline paste stays one unsent draft. Shift+Enter requires a terminal that reports the modifier; Ctrl+J works as the newline fallback.

Enter during generation queues a **local draft**. It has not yet reached ChatGPT — report it as
"queued locally", never as "sent" or "delivered"; only `queue run` submits. Outgoing messages distinguish submitting, website-observed submission, answered and unconfirmed outcomes. Stopping or a failed response pauses queued drafts. The TUI and CLI share the same durable account queue. Enter during generation saves a paused queued draft; use Option+Q → Run shared account queue to submit in order. Pending local outbox copies remain checkpointed until the shared store acknowledges their IDs. Older TUI drafts migrate paused. This is not the website's native queue; native steering remains an explicit mapping gap.

Quitting saves an account-scoped private checkpoint of the conversation, scroll position, draft, attachments, navigation and queue. Reopening restores queued drafts paused. Ctrl+Q detaches local RPCs without stopping website generation. In Ctrl+K, choose **Reconcile current conversation with website** to refresh confirmed messages while preserving unresolved local drafts.

GPT-6 Astra is observed in **Work** mode. Choose Work in Option+M, then Astra, or start with:

```sh
chatgpt --mode Work --model "GPT-6 Astra"
chatgpt chat mode --mode Work
chatgpt models options
chatgpt chat model --model "GPT-6 Astra"
```

Website Work exhaustion triggers a verified switch to Chat before submission, retaining Chat's observed settings. A quota warning after a submit attempt triggers a switch attempt and an explicit uncertain-outcome error; that message is not automatically replayed. The currently selected model and effort are website observations, not guesses based on model names.

### Message timestamps

Every transcript message shows a local calendar date, time to the second, and UTC offset. Website creation timestamps are used when returned in conversation data. `local` marks a locally created send/response record; `seen` marks the first local observation when the website does not expose creation time. These labels never claim an observation time is the original send time. Timestamps persist across reconciliation, hot reload and quit/reopen, including a streamed DOM turn later receiving a server message ID.

## Accounts and browsers

```sh
chatgpt accounts list
chatgpt accounts add personal --label Personal
chatgpt accounts add attached --cdp http://127.0.0.1:9223
chatgpt accounts use personal
chatgpt browsers
chatgpt browser start
chatgpt browser mode headed
chatgpt browser mode headless
chatgpt browser stop
chatgpt daemon stop
```

Use `--account ID` on commands to select a specific account. Account records can carry `--profile`, `--browser`, `--workspace`, `--source` and `--reference`. AccountTracker/APIPlan source descriptors are integration contracts, not an automatic credential import. Attached browsers are not terminated by stopping the worker. Headless operation does not by itself supply microphone, camera or audio output.

## Conversations and generation

> 🛑 **`chat new`, `chat send`, `chat edit`, `chat branch`, `chat regenerate` all send to his account.**
> **What:** a real message in a real conversation, generated by his subscription.
> **Cost:** one submission plus its generation each. `conversations list --all` additionally paginates
> the full active *and* archived catalogs — 11+ pages per scope at 1,063 chats, and prime 429 material.
> **Reversible:** **No.** There is no unsend, and an uncertain submission must never be replayed.
> **Rule:** every send needs (a) his word for that specific send, (b) a conversation he named or a new
> throwaway one, (c) one at a time. To read conversations without traffic use
> `chatgpt conversations cached` and `chatgpt conversations search`.

```sh
chatgpt conversations list --all
chatgpt conversations cached
chatgpt conversations get CHAT_ID
chatgpt conversations search "words" --full-text
chatgpt conversations path CHAT_ID --node NODE_ID
chatgpt conversations export CHAT_ID --output /absolute/chat.json
chatgpt conversations open CHAT_ID
chatgpt chat new --text "Hello" --jsonl
chatgpt chat send --conversation CHAT_ID --text "Continue" --jsonl
chatgpt chat edit --message MESSAGE_ID --text "Revised prompt"
chatgpt chat branch --message MESSAGE_ID
chatgpt chat regenerate --message MESSAGE_ID
chatgpt chat stop
chatgpt models list
chatgpt models options
chatgpt chat model --model "EXACT WEBSITE LABEL"
chatgpt chat effort --effort "EXACT WEBSITE LABEL"
chatgpt conversations rename CHAT_ID --title "New title"
chatgpt conversations pin CHAT_ID
chatgpt conversations unpin CHAT_ID
chatgpt conversations archive CHAT_ID
chatgpt conversations unarchive CHAT_ID
```

Generation accepts `--project PROJECT_ID` or `--gpt GPT_ID`. Editing, branching and regeneration operate on the currently opened conversation. Search reads the local index; it cannot find message content that has not been captured.

Rename, pin/unpin and archive/unarchive were live-tested **once, on one dedicated integration chat, and restored afterwards**. That is evidence the mechanism works — not permission to run them on chats he cares about. Management requires the target row to be discoverable in the relevant website surface. Duplicate titles or missing controls stop the operation. An unknown outcome is a reason to inspect current state before retrying, not evidence that nothing happened.

> 🛑 **`chatgpt conversations share CHAT_ID` — owner's permission required.**
> **What:** opens the observed share launcher on a private conversation. Verified in
> `src/chatgpt/conversation-actions.ts`: it clicks the Share menu item and returns
> `{changed:false, stage:'share-launcher-clicked', shared:false}` — this operation does **not** publish
> a link by itself. It does leave a share dialog open on his live, signed-in page.
> **Cost:** 1 UI interaction on the real account.
> **Reversible:** There is **no working unshare**. `conversations.unshare` is routed in `service.ts`
> but `ConversationActions.manage` has no `unshare` label, so it fails with
> *"Unsupported conversation action: its website flow has not been observed."* Only he may publish or
> revoke a link.
> **Rule:** never run it to "have a look". No delete operation is implemented here — and do not
> reach for `api request` to build one.

> 🛑 **`conversations rename|pin|unpin|archive|unarchive` mutate chats he owns.**
> **Cost:** one website write each. **Reversible:** only by the inverse action, and only if it succeeds.
> **Rule:** allowed only on a conversation created for testing in this session, restored afterwards.

## Durable CLI message queue

This account-scoped disk queue is shared with the TUI. Adding, editing and resuming do **not** submit messages; only `queue run` sends. Every item needs an explicit conversation or `--new` context. (Binding the website identity needs `chatgpt status`, which is itself a live command — see the Start section.)

> 🛑 **`chatgpt queue run` submits everything eligible, oldest first.**
> **What:** sends the queued drafts to his account, in order.
> **Cost:** one real send per item, plus generation. A queue left over from an earlier session can
> contain drafts he never approved.
> **Reversible:** **No.**
> **Rule:** never run the queue without first running `chatgpt queue list` and showing him exactly
> which items would be sent. `queue list`, `queue status`, `queue pause` are local and safe.

```sh
chatgpt queue add --conversation CHAT_ID --text "Continue" --file /absolute/image.png --client-id my-stable-draft
chatgpt queue add --new --project PROJECT_ID --text "Start here"
chatgpt queue list
chatgpt queue edit ITEM_ID --text "Revised draft"
chatgpt queue reorder ITEM_ID --index 0
chatgpt queue remove ITEM_ID
chatgpt queue resume
chatgpt queue run --max-items 1 --jsonl
chatgpt queue pause
chatgpt queue status
chatgpt queue reconcile ITEM_ID
chatgpt queue retry ITEM_ID
```

`--client-id KEY` makes adding the same original draft idempotent: a lost reply can be retried without creating another item. Reusing that key with a different original payload fails. A deliberately removed item is never recreated by retrying its old key. The TUI checkpoints these IDs before migration.

Shared queue runs open a separate target-labeled response view with live text, thinking and media. Escape returns to the current conversation without mixing replies from other targets into it. Completed items offer an explicit action to open their result conversation. Pausing the shared queue leaves the current response running and prevents upcoming items from starting.

Positions are zero-based. Run streams item IDs, request IDs and nested website events, then returns the full queue status; inspect each item's phase. A runner crash restores uncertain attempts as `unknown` and pauses. Reconciliation uses the matching private operation receipt, never a guessed absence from the website. Unknown receipts block replay. Proven `not-submitted` failures retain their draft; explicit retry assigns a new request ID and leaves the queue paused until resume. Pause or client detachment takes effect between items and does not stop an active website response.

## Projects, GPTs and settings

```sh
chatgpt projects list
chatgpt projects get PROJECT_ID
chatgpt projects chats PROJECT_ID
chatgpt gpts list
chatgpt gpts owned
chatgpt gpts bootstrap
chatgpt gpts catalog --scope explore
chatgpt gpts catalog --scope recent
chatgpt gpts catalog --scope trending
chatgpt gpts get GPT_ID
chatgpt settings get
chatgpt settings instructions
chatgpt settings open --section General
chatgpt settings map --jsonl
chatgpt settings set --section General --name "EXACT CONTROL NAME" --value "VALUE"
chatgpt capabilities list
```

`gpts list` and `gpts owned` enumerate My GPTs with full observed pagination; the current account’s verified result was zero owned GPTs. `gpts bootstrap` preserves the separate bootstrap scope. `gpts catalog` supports explore, anonymous, recent, owned and trending scopes; inspect each pagination receipt. Public discovery results are not owned-account data.

> 🛑 **`chatgpt settings set` changes his real ChatGPT settings — owner's permission required, per control.**
> **What:** flips a switch, fills a text input or picks a combobox value in his live account settings.
> **Cost:** one website write.
> **Reversible:** only by setting the old value back by hand, and UI readback does not prove server
> persistence either way.
> **Rule:** settings are **read-only** for an agent. `settings get`, `settings instructions`,
> `settings map` and `settings open` are the allowed verbs. Never run `settings set` to make a test
> pass, and never touch keyboard shortcuts or data controls without his explicit word for that control.

Settings discovery preserves nested controls, trigger paths and unexplored items. `settings set` supports mapped switches, text inputs and comboboxes. Text inputs can use `--commit "EXACT SAVE LABEL"`; no save control is guessed. UI readback does not independently prove server persistence. Capability reports include Health, Sites, Work, Apps, Library, Images and media/device gaps; generic browser access never means full feature parity.

Additional read operations: `account get`, `features list`, `tasks list`, `plugins list`, `connectors list`, `pins list` and `voices list`. Availability depends on the account and website response.

## Media and audio

```sh
chatgpt ui upload /absolute/file.pdf
chatgpt media list --include-raw --output /absolute/private-catalog.json
chatgpt media download FILE_REFERENCE --output /absolute/asset.bin
chatgpt media export --catalog /absolute/private-catalog.json --output /absolute/media-export --jsonl
chatgpt media audit --output /absolute/media-export
chatgpt audio input --path /absolute/fixture.wav
chatgpt dictation start
chatgpt audio play
chatgpt audio status
chatgpt dictation stop
chatgpt audio clear
chatgpt dictation transcribe --file /absolute/fixture.wav
chatgpt audio output capture --output /absolute/response.webm --duration 30 --jsonl
chatgpt audio output status
chatgpt voice controls
chatgpt voice start
chatgpt voice stop
```

> 🛑 **`media export`, `media download`, `media list` and `ui upload` all reach the account.**
> **What:** authenticated asset downloads, catalog pagination, and a real file upload into the page.
> **Cost:** `media export` is hundreds of megabytes of authenticated downloads (the current store is
> 248/248 targets, 786,536,421 bytes). A 429 mid-run stops with a resumable receipt.
> **Reversible:** downloads are local, but the requests and the rate-limit damage are not.
> **Rule:** the export is already byte-complete — read `chatgpt media audit --output <dir>` instead of
> re-running it. Voice, dictation and audio capture also drive the live page; they need his word.

Start output capture before starting Voice in another terminal; the recorder observes website playback and reports whether audio was detected.

Audio input prepares an explicit local file for the website’s next audio-only microphone stream; `audio play` feeds that prepared input after voice/dictation starts. It is not a general speaker playback command. Use `audio clear` to restore the original input behavior. Supported input formats include WAV, MP3, M4A, Ogg, WebM and AIFF, with a 16 MiB limit. Explicit fixture input was verified in a live website Voice session. Remote WebRTC response capture produced 47,102 bytes of Opus audio (48 kHz stereo, 30.47 seconds), with non-silent decoded samples. An earlier WebAudio-only capture was digital silence; arming a recorder alone is not proof of received speech. Camera and screen-sharing parity remain unverified.

Media export saves only positively identified ChatGPT-owned assets; external-provider records remain metadata. Files are private, MIME-aware and hash-checked. A 228,757,004-byte asset (approximately 229 MB) passed the chunked transfer and hash verification. This verifies that transport, not completion of every media job. See [media scope and evidence](CHATGPT-MEDIA-MAP.md).

## Local takeout and rate-limit playbook

> 🛑 **`chatgpt takeout` with no subcommand IS the bulk crawl. It is the command that caused the
> 2026-09-15 19:51 "STOP EVERYTHING IMMEDIATELY".**
> **What:** `bin/chatgpt.ts` maps a bare `takeout` to the operation `takeout.run` — a full crawl of
> every conversation tree into a local archive. `--output` only chooses where the archive lands; it
> does not make the command local.
> **Cost:** up to **1,063 authenticated conversation-detail reads**, paced 5 s apart (819 of them are
> still outstanding on the current archive), plus catalog and media requests. It is the single largest
> quota and rate-limit consumer in this client, and it already drove the account into repeated 429s.
> **Reversible:** **No.** Requests sent are sent; the rate-limit cooldown is the account's.
> **Rule:** the only takeout verbs an agent may run on its own judgement are `takeout status`,
> `takeout audit` and `takeout watch-status` — all three read local disk. `takeout`, `takeout run`,
> `takeout --original`, `takeout watch`, `takeout pause` and `takeout resume` need his word in the
> current conversation.

```sh
chatgpt takeout --output /absolute/private-archive --jsonl
chatgpt takeout status --archive /absolute/private-archive
chatgpt takeout pause
chatgpt takeout resume
chatgpt takeout --output /absolute/private-archive --jsonl
chatgpt takeout audit --archive /absolute/private-archive
```

The archive retains full returned conversation mappings and branches, raw catalog/account responses, metadata, resolved files, hashes, coverage and checkpoints. Resume refreshes catalogs and account responses, reuses intact conversation snapshots, and refetches conversations whose reported update timestamp changed. An account evolving during the run is not an atomic server snapshot. Use a new directory to retain separate historical snapshots.

`takeout status`, `takeout audit` and `takeout watch-status` read local disk only and are safe while frozen. `takeout pause` gates conversation-detail reads. `takeout resume` releases that gate; it does **not** restart a run that already exited — but it does remove the brake, so it needs his word like any other live takeout verb.

> 🛑 **`chatgpt takeout watch` arms an unattended crawl that outlives your session.**
> **What:** writes `{"enabled":true}` into `takeout-supervisor.json`. From then on **every**
> `ChatGPTService` construction — that is, every daemon start — resumes the archive crawl by itself
> (`src/chatgpt/service.ts` constructor). Nobody has to run a command for traffic to begin.
> **Cost:** the whole crawl, repeatedly, with no operator present.
> **Reversible:** only by `chatgpt takeout unwatch` (and the flag stays on disk until then).
> **Rule:** never arm it without his word. It is currently disabled on his account, on purpose:
> `"disabledBy": "chatgpt-cli teammate 2026-09-15 21:21 after his STOP"`.

> 🛑 **Never `rm` an archive `.lock` by hand.** Only `chatgpt takeout watch-status` reporting
> `state:"stale-lock"` says anything about that lock, and the recovery code re-validates it itself.
> A live daemon PID or a missing log entry never proves a lock is stale. Two writers on one account is
> a data-corruption event. After cooldown, rerun `takeout` with the same output directory to continue. Inspect status’s `rateLimit.retryAt`, respect Retry-After and avoid simultaneous bulk retries. An exhausted detail rate limit checkpoints and stops. A media-export 429 also stops with resumable progress.

Takeout reuses verified files from the account’s default `media-export` directory, or `--media-export /absolute/cache`. Integrity means all tracked bytes match their hashes. Lossless preservation means the returned raw data was retained; it does not recover deleted, expired or server-omitted data. `complete:false` remains appropriate while required or unobserved scopes have gaps. The official export is a separate website request:

> 🛑 **`chatgpt takeout --original` submits OpenAI's official account export. It cannot be recalled.**
> **What:** `--original` does **not** mean "the original data" or "the original method". Verified in
> `src/chatgpt/actions.ts` `originalExport(true)`: it opens Settings → Data controls, clicks
> **Export data**, then clicks **Confirm export** — with no local confirmation prompt anywhere in the
> path. OpenAI then emails him a download link.
> **Cost:** 1 real request to OpenAI, plus an email to his inbox.
> **Reversible:** **No.** There is no cancel, no recall, and no way to un-request it.
> **Rule:** FORBIDDEN unless he himself types the word "original" for this command in the current
> conversation. The local archive (`takeout`) is a different thing and is not a substitute permission.

```sh
chatgpt takeout --original
```

The confirmation dialog was inspected with cancellation; a live official export submission was not part of validation. `originalExport(false)` is the inspection-only form used for that check, and it is not reachable from the CLI flag.

## Invoices

```sh
chatgpt invoices list
chatgpt invoices download INVOICE_ID --output /absolute/invoice.pdf
chatgpt invoices download --all
chatgpt invoices sync --project-path /absolute/invoices --jsonl
chatgpt invoices watch --interval 21600 --project-path /absolute/invoices
chatgpt invoices watcher
chatgpt invoices unwatch
```

> 🛑 **`invoices download --all`, `invoices sync` and `invoices watch` all reach the account.**
> **What:** `--all` lists every invoice and downloads each Stripe PDF through the live billing surface;
> `sync` additionally files them; `watch` starts a repeating background job.
> **Cost:** 1 listing + 1 download per invoice, then repeats on the watcher interval.
> **Reversible:** imports are deduplicated by provider plus invoice number; the requests are not.
> **Rule:** `invoices watcher` (status) is the safe read verb; `invoices list` is already live traffic.
> `--all`, `sync` and `watch` need his word.

> 🛑 **Never pass `--acknowledge` to clear a watcher pause.**
> The watcher is currently `paused:"action-required"` with a real `lastError`
> ("Invoice downloaded but filing failed"). `--acknowledge` erases that pause **and** the recorded
> error, then restarts syncing — hiding a possible duplicate or half-finished import. Read
> `invoices watcher` and inspect the invoices ledger first, and only he decides to acknowledge.

Sync preserves originals and uses the existing invoices project’s parser, naming, locking and ledger. Provider plus invoice number identifies duplicates. Watcher configuration/checkpoints persist in account state; periodic execution needs the daemon running. This is separate from installing OS-login autostart.

## Agent monitoring, recovery and hot reload

```sh
chatgpt monitor events --limit 100
chatgpt monitor watch --jsonl
chatgpt runtime reload
chatgpt adapter get
chatgpt adapter validate --path /absolute/adapter.json
chatgpt adapter promote --path /absolute/adapter.json
chatgpt adapter rollback --version VERSION
chatgpt flow validate /absolute/flow.json
chatgpt flow run /absolute/flow.json --run-id RUN_ID --jsonl
chatgpt flow status --run-id RUN_ID
chatgpt flow run /absolute/flow.json --run-id RUN_ID --resume --jsonl
```

`--jsonl` emits event envelopes followed by a result. Runtime gating checks revisions before operations, reloads candidates and retains the last good runtime if validation fails. Adapter validation proves shape, not website behavior. Declarative flows journal each step and re-read pending definitions at boundaries; attempted steps cannot be rewritten. An uncertain mutation is reconciled against its explicit postcondition and is never blindly replayed.

For drift, inspect a fresh snapshot and the classified error, then repair the adapter or flow. For authentication failure, use the selected account’s website login. For an unknown write outcome, inspect the exact existing object before making another change.

## Browser inspection

> 🛑 **`chatgpt api request` is the most dangerous command in this client.**
> **What:** an arbitrary authenticated call to any `/backend-api/` path, with **any HTTP method and any
> JSON body** (`src/chatgpt/service.ts` `api.request` → `src/chatgpt/browser.py` `request`). The only
> checks are that the path starts with `/backend-api/` and carries no host; there is no method
> allowlist, no path allowlist, and no confirmation. It runs with his live bearer token.
> **Cost:** 1 request — whose effect is whatever that endpoint does. The docs elsewhere say
> "conversation delete is not implemented"; `api request` with the right method and body makes it one
> line away. That would be a deletion of his data, not a missing feature.
> **Reversible:** **No**, and often not even observable afterwards.
> **Rule:** `api request` is a read-only escape hatch with `--method GET` and no `--body`, used only
> for a route that has already been observed. Any other method — POST, PATCH, PUT, DELETE — is
> forbidden without his explicit word for that exact path and body. Prefer the typed read operations.

> 🛑 **`ui click|fill|key|text|mouse|scroll|upload` type blindly into a live signed-in page.**
> Delete buttons, share controls, settings toggles and the composer all live on that page, and a stale
> reference can land the click somewhere else entirely.
> **Rule:** inspection happens on a dedicated auxiliary surface (`--surface inspection`) and stays
> read-only: `ui snapshot`, `ui inspect`, `map scan`. Acting on the main surface needs his word.

```sh
chatgpt ui snapshot
chatgpt ui hover --ref REF --epoch EPOCH
chatgpt ui click --ref REF --epoch EPOCH
chatgpt ui fill --ref REF --epoch EPOCH --text "value"
chatgpt ui key --key Escape
chatgpt ui text --text "literal text"
chatgpt ui mouse --x 300 --y 400
chatgpt ui scroll --dy 600
chatgpt ui inspect --ref REF --epoch EPOCH
chatgpt ui viewport --width 1400 --height 950
chatgpt ui screenshot --output /absolute/screen.png
chatgpt surface open --surface inspection --url https://chatgpt.com/
chatgpt ui snapshot --surface inspection
chatgpt surface activate --surface inspection
chatgpt surface close --surface inspection
chatgpt map scan
chatgpt map network
chatgpt map request --id REQUEST_ID --surface inspection
chatgpt map response --id REQUEST_ID --surface inspection
chatgpt api request --path /backend-api/models
```

References belong to their snapshot epoch and surface, and expire on the next snapshot. Take another snapshot after changes; never reuse an old `--ref`. Raw snapshots, response captures and catalog exports can contain private account data; keep them outside the repository. Browser passthrough is an inspection tool, not proof of every feature’s implementation.

For the verified Jimmy comparison and internals, read [architecture](CHATGPT-ARCHITECTURE.md). For dated progress and unresolved work, read [execution ledger](CHATGPT-PLAN.md). For the full slash surface and its confirmation gaps, read [slash commands](CHATGPT-SLASH-COMMANDS.md).

Safety pass 2026-09-16: the stop control, direct mode, the cost index and every 🛑 block on this page were added or rewritten against the code; the freeze and direct-mode facts cite `src/chatgpt/{freeze,transport,service,daemon,tui}.ts`, `src/chatgpt/browser.py` and `bin/chatgpt.ts`. No capability was removed from this page — each one was priced.
