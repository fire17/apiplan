# ChatGPT slash-command inventory

This is the source-of-truth inventory for exposing the CLI and terminal workspace through slash commands. Tests require the registry to match every service dispatch operation exactly, while local commands remain a separate fixed set. It separates four states:

- **RPC**: implemented by `ChatGPTService.execute` or the durable queue dispatcher.
- **Local**: implemented in the CLI or TUI process without a service RPC.
- **Primitive**: a low-level browser operation; it requires a fresh snapshot reference or an explicitly named auxiliary surface.
- **Unimplemented**: catalogued by `capabilities.ts` but has no typed operation. A generic click or API request does not promote it to implemented.

Operation completion is not semantic parity. Mutation commands still require their operation-specific receipt and postcondition.

## Safety contract for this page (2026-09-16)

> 🛑 **A slash command runs the moment you press Enter. Nothing on this page asks for confirmation.**
> `parseSlash` (`src/chatgpt/slash.ts`) resolves the words to an operation and the TUI's
> `slashOperation` dispatches it straight to the service. There is no destructive-action prompt, no
> dry run, and no "are you sure" anywhere in that path. **Availability on this page is not permission.**

Two forms reach the same 137 operations, and **both** are unguarded:

1. The dotted form — `/settings.set …`, `/conversations.share ID`, `/takeout.run`, `/api.request …` —
   because every name in `serviceOperations` is matched directly.
2. `/run <operation>` — which additionally accepts any dotted name you type; unknown names fail inside
   the service with `Unknown operation`, after the parse.

So a rule that forbids only `/run` is not enough. **The rule is per operation, not per syntax.**

| While the account is frozen, these are the only slash commands to run without fresh permission |
| --- |
| `/freeze`, `/thaw` (his word only), `/freeze.status`, `/status` *(local only while frozen)*, `/conversations cached`, `/conversations search`, `/takeout status`, `/takeout audit`, `/takeout watch-status`, `/monitor events`, `/receipts list`, `/receipts get`, `/capabilities list`, `/invoices watcher`, `/adapter get`, `/online list`, `/online status`, `/queue list`, `/queue status`, `/help`, `/commands` |

Everything else in the tables below reaches chatgpt.com, spends quota, or changes an object the
account owner owns. The 🛑 rows are the ones that cause harm fastest; read
[the quickstart's cost index](CHATGPT-QUICKSTART.md) for what each one costs and whether it can be undone.

## Syntax contract

```text
/<group> <action> [POSITIONAL] [--flag VALUE] [--flag=VALUE]
```

Quoted text stays one value. Repeat `--file PATH` for multiple attachments. Boolean flags accept their bare form or `--flag=false`.

Showing the resolved RPC and arguments before destructive or account-changing work is a **design
intent that is not implemented**: no confirmation step exists in `slash.ts` or `tui.ts` today. Until
one does, the operator is the confirmation step.

Common flags:

| Purpose | Flags |
| --- | --- |
| Account/output | `--account ID`, `--json`, `--jsonl`, `--output PATH` |
| Selection | `--id ID`, `--conversation ID`, `--project ID`, `--gpt ID`, `--message ID`, `--node ID`, `--surface NAME` |
| Content | `--text TEXT`, repeated `--file PATH`, `--title TITLE`, `--name NAME`, `--value VALUE` |
| Catalog bounds | `--limit N`, `--max-pages N`, `--page-size N`, `--cursor TOKEN`, `--scope NAME`, `--archived`, `--all` |
| Browser controls | `--ref N`, `--epoch EPOCH`, `--key KEY`, `--x N`, `--y N`, `--dy N`, `--width N`, `--height N` |

## Local TUI aliases

These commands operate on TUI state or open an existing TUI menu. They must not be translated into an invented server operation.
Local aliases accept plain or quoted positional words only. Use the explicit dotted RPC command when named flags are needed.

| Command | Exact local behavior |
| --- | --- |
| `/freeze [REASON]` | **Stop all site traffic now.** Writes the durable freeze flag in the TUI process itself (no daemon needed), sets the ❄ FROZEN header marker, and clicks the website Stop control if a generation is running. Safe to run at any time. |
| `/thaw` | Clear the freeze and allow site traffic again. **The account owner's decision only** — never a way to clear a `FROZEN` error. |
| `/help` | Open slash/keyboard help. |
| `/commands` | Open the complete command palette. |
| `/new` | Reset the workspace to a new-conversation draft. No submission. |
| `/send TEXT` | Submit through the existing phase-aware TUI send path in the current context. With no text, attached files are required. |
| `/model [NAME]` | With no name, open the website-verified model chooser. With a name, call `chat.model` in the current context. |
| `/effort [NAME]` | With no name, open the effort chooser. With a name, call `chat.effort` in the current context. |
| `/mode [Chat|Work]` | With no value, open the two-mode chooser. With a value, apply that mode in the current context. |
| `/queue` | Open the shared durable queue menu. Sending remains explicit. |
| `/stop` | Request `chat.stop`; retain partial output and pause local queue progression. Works while frozen: stopping reduces activity. |
| `/attach PATH` | Add a local attachment to the composer. No upload or send occurs yet. |
| `/attachments` | Review or remove pending local attachments. |
| `/media` | Inspect received media; downloading remains a separate choice. |
| `/thinking` | Toggle display of already observed thinking details locally. |
| `/search` | Prompt for a full-text conversation search. |
| `/conversations`, `/projects`, `/gpts` | Switch and refresh that navigation collection. |
| `/refresh` | Refresh the current navigation collection. |
| `/reconcile` | Reconcile the current conversation through `chat.reconcile`; never resend. |
| `/browser` | Open the live browser viewport in the TUI. |
| `/inspect` | Take a fresh browser snapshot and open the control inspector. |
| `/account`, `/accounts` | Open the guarded local account switcher. |
| `/message` | Open saved-message view/edit/branch/regenerate actions. |
| `/action WORDS` | Run an exact palette label or open the palette filtered by those words. |
| `/monitor` | Open the recent-events action. |
| `/quit` | Checkpoint and leave the terminal workspace. |

Every current palette entry also receives a generated `/action-<normalized-label>` alias. This is how open-current-context, show-browser-window, local media playback, browser-media inspection, monitor follow/stop, invoice/archive flows, and local outbox review remain directly slash-addressable without maintaining a second manual alias list.

## Canonical RPC commands

### Runtime, receipts, and durable queue

| Slash command | RPC / flags |
| --- | --- |
| `/freeze.set [--frozen false] [--reason TEXT]` | `freeze.set`; the durable stop switch. Runs without a daemon or browser (it is in `DIRECT_READ_OPERATIONS`). Freezing while a generation is live also clicks the website Stop control. |
| `/freeze.status` | `freeze.status`; reports `frozen`, `at`, `by`, `reason` and `browserRunning` from disk. No site traffic. |
| `/status` | `status`. 🛑 **Live unless frozen:** `service.ts` excludes `status` from its no-start allowlist unless the account is frozen, so on a thawed account it starts the browser worker (two chatgpt.com tabs) and reads website identity. Frozen, it is a pure local read. |
| `/runtime reload` | `runtime.reload` |
| `/receipts list [--limit N]` | `receipts.list` |
| `/receipts get ID` | `receipts.get --id ID` |
| `/queue add --conversation ID|--new --text TEXT [--file PATH ...] [--client-id KEY]` | `queue.add` |
| `/queue list`, `/queue status` | `queue.list`, `queue.status` |
| `/queue edit ID --text TEXT` | `queue.edit --id ID` |
| `/queue remove ID` | `queue.remove --id ID` |
| `/queue reorder ID --index N` | `queue.reorder --id ID --index N` |
| `/queue pause`, `/queue resume` | Pause or unpause scheduling; neither command sends. |
| 🛑 `/queue run [--max-items N]` | Sends eligible queued items in order — including drafts left over from an earlier session. Run `/queue list` and show him exactly what would be sent first. |
| `/queue retry ID` | Retry only a receipt-certified non-submission with a new request ID. |
| `/queue reconcile ID` | Reconcile a durable receipt without resending. |

### Website API request receipts

| Slash command | RPC / flags |
| --- | --- |
| `/online list [--limit N]` | `online.list`; list redacted metadata from private local website API receipts without starting the browser. |
| `/online status REQUEST_ID [--include-raw]` | `online.status`; show status, model, account, timestamps, conversation/error, result counts, receipt path and the safe next action. `--include-raw` explicitly includes saved response deltas and may expose conversation text. |

Uncertain or active receipts instruct the operator to inspect the saved conversation and receipt without resubmitting or clearing its lock. A `not-submitted` receipt may be retried after its preparation failure is corrected.

### Conversational tool harness

| Slash command | RPC / flags |
| --- | --- |
| `/harness test [--turns 6] [--model Latest] [--effort Instant] [--timeout MS]` | `harness.test`; run the bounded staged website integration with at least five and at most twenty parent turns. |
| `/harness run --text OBJECTIVE [--turns 8] [--model Latest] [--effort Instant] [--timeout MS]` | `harness.run`; run a one-to-twenty-turn objective on dedicated agent surfaces. |
| `/harness list` | `harness.list`; read saved run summaries without starting a browser. |
| `/harness status --run-id ID` | `harness.status`; read one durable `run-state.json`. |

Harness runs require a previously verified attached-browser account. They use Chat mode with Latest/Instant defaults, open a dedicated surface and conversation per agent, persist private receipts, and block automatic replay when a website submission is uncertain. `--jsonl` streams harness events in the CLI; it is an output option rather than an RPC argument.

### Conversations and generation

| Slash command | RPC / flags |
| --- | --- |
| `/conversations list [--archived|--all] [--page-size N] [--max-pages N]` | `conversations.list` |
| `/conversations cached` | Local observed chat index through `conversations.cached`. |
| `/conversations search QUERY [--full-text]` | `conversations.search --query QUERY` |
| `/conversations get ID [--cached]` | `conversations.get --id ID` |
| `/conversations path ID [--node ID] [--cached]` | `conversations.path` |
| `/conversations open ID` | `conversations.open --conversation ID` |
| `/conversations export ID --output PATH` | `conversations.export` |
| 🛑 `/conversations rename ID --title TITLE` | `conversations.rename`; a real write on a chat he owns. Allowed only on a conversation you created for testing in this session, restored afterwards. |
| 🛑 `/conversations pin ID`, `/conversations unpin ID` | Typed website actions with exact-row verification — and real mutations of his sidebar. |
| 🛑 `/conversations archive ID`, `/conversations unarchive ID` | Typed website actions with exact-row verification — and real mutations. Archive removes the chat from his active list. |
| 🛑 `/conversations share ID` | Clicks the Share menu item on a private conversation, opening the share launcher on his live page. It returns `changed:false, stage:'share-launcher-clicked', shared:false` — it does not publish a link by itself. **There is no working unshare.** Owner's permission required. |
| `/conversations unshare ID` | Routed in `service.ts`, but `ConversationActions.manage` has no `unshare` label, so it always fails with *"Unsupported conversation action: its website flow has not been observed."* No control is clicked. Treat sharing as one-way. |
| 🛑 `/chat new TEXT [--model NAME] [--effort NAME] [--mode Chat|Work] [--file PATH ...]` | `chat.new`; sends a real message and spends quota. **No unsend exists.** Needs his word for that specific send. |
| 🛑 `/chat send TEXT --conversation ID [--file PATH ...]` | `chat.send`; sends into an existing conversation of his. Same rule. |
| `/chat stop` | `chat.stop` |
| `/chat reconcile [--conversation ID]` | Read-only website reconciliation. |
| `/chat edit --message ID --text TEXT` | `chat.edit` |
| `/chat branch --message ID` | `chat.branch` |
| `/chat regenerate --message ID` | `chat.regenerate` |
| `/chat mode Chat|Work [--surface NAME]` | `chat.mode` |
| `/chat model NAME [--surface NAME]` | `chat.model` |
| `/chat effort NAME [--surface NAME]` | `chat.effort` |
| `/models list`, `/models options` | Account model catalog and current website choices. |
| `/thinking expand --ref N --epoch EPOCH [--surface NAME]` | Primitive for a currently expandable observed panel. |

### Projects, GPTs, account data, and settings

| Slash command | RPC / flags |
| --- | --- |
| `/projects list [--max-pages N]` | `projects.list` |
| `/projects get ID` | `projects.get` |
| `/projects chats ID` | `projects.chats` |
| `/gpts bootstrap`, `/gpts list`, `/gpts owned` | Bootstrap or owned catalogs; zero rows are valid account-scoped results. |
| `/gpts catalog [--scope explore|owned] [--max-pages N]` | `gpts.catalog` |
| `/gpts get ID` | `gpts.get` |
| `/account get` | `account.get` |
| `/features list` | `features.list` |
| `/tasks list [--cursor TOKEN] [--max-pages N]` | `tasks.list`; preserves task-aware pagination. |
| `/plugins list`, `/connectors list`, `/pins list` | Read the observed account routes. |
| `/settings get`, `/settings instructions` | Read account settings or instructions. |
| `/settings open SECTION` | Navigate to one exact observed settings section. |
| `/settings map` | Read-only map of sections, nested surfaces, and controls. |
| 🛑 `/settings set --section SECTION --name CONTROL --value VALUE` | Changes a real setting in his account. "Guarded" means the control is matched and read back — **not** that anyone was asked. Settings are read-only for an agent; `settings get/map/open/instructions` are the allowed verbs. |
| `/capabilities list`, `/map capabilities` | Current implementation/evidence/gap report. |

### Archive and media

| Slash command | RPC / flags |
| --- | --- |
| 🛑 `/takeout run [--output DIR] [--media-export DIR] [--max-retries N]` | The bulk crawl: up to 1,063 conversation-detail reads paced 5 s apart. This is the command behind the 2026-09-15 "STOP EVERYTHING IMMEDIATELY". `--output` only chooses where the archive lands. |
| 🛑 `/takeout run --original` | Submits OpenAI's **official** account export: clicks Export data, then Confirm export, with no local prompt. He receives an email. **Irreversible** — forbidden unless he himself says "original" in the current conversation. |
| `/takeout status [--archive DIR]`, `/takeout audit [--archive DIR]` | Disk/status checks. |
| `/takeout pause`, `/takeout resume` | Pause/resume conversation-detail reads while preserving checkpoints. |
| 🛑 `/takeout watch [--output DIR]` | Arms a durable background writer (`takeout-supervisor.json enabled:true`): every later daemon start resumes the crawl unattended, until `/takeout unwatch`. Currently disabled on his account on purpose. |
| `/takeout watch-status [--archive DIR]` | Local disk read; answered without the daemon. Safe while frozen. `/takeout unwatch [--archive DIR]` disarms the background writer. |
| `/media list [--include-raw] [--max-pages N]` | Root, image-library, generated, upload, archived/bootstrap catalogs. |
| `/media download ID --output PATH` | Resolve and verify one observed media reference. |
| 🛑 `/media export [--catalog FILE] [--output DIR]` | Hundreds of megabytes of authenticated downloads. The current export is already byte-complete (248/248 targets, 786,536,421 bytes) — read `/media audit` instead of re-running it. |
| `/media audit [--output DIR]` | Hash and manifest audit. |

### Voice, dictation, and audio

| Slash command | RPC / flags |
| --- | --- |
| `/voices list` | `voices.list` |
| `/voice start`, `/voice stop`, `/voice controls` | Website Voice lifecycle and observed controls. |
| `/dictation start`, `/dictation stop`, `/dictation controls` | Website dictation lifecycle and controls. |
| `/dictation transcribe --path FILE` | Inject and transcribe an explicit local fixture. |
| `/audio input --path FILE` | Inject explicit audio input. |
| `/audio outputs`, `/audio play`, `/audio status`, `/audio clear` | Local/browser audio output inventory and playback state. |
| `/audio output arm`, `/audio output read`, `/audio output status`, `/audio output stop` | Output-capture lifecycle. |
| `/audio output capture [--output PATH] [--duration N] [--max-chunks N] [--max-bytes N] [--timeslice-ms N]` | Bounded capture with structured progress. |

### Invoices, flows, monitoring, and adapters

| Slash command | RPC / flags |
| --- | --- |
| `/invoices list` | `invoices.list` |
| 🛑 `/invoices download --all`, `/invoices sync` | Bulk Stripe downloads (and, for sync, filing). One listing plus one download per invoice. `/invoices download ID` is a single live download. |
| `/invoices sync [--project-path PATH]` | Download/import with durable deduplication. |
| 🛑 `/invoices watch [--interval SECONDS] [--project-path PATH] [--acknowledge]` | Starts a repeating background sync. `--acknowledge` erases the current `action-required` pause **and** its recorded `lastError`, which can hide a duplicate or half-finished import. Read `/invoices watcher` first; only he acknowledges. |
| `/invoices watcher`, `/invoices unwatch` | Watcher status/stop. |
| `/flow validate PATH` | Validate without execution. |
| `/flow run PATH [--dry-run] [--run-id ID] [--resume]` | Preview, run, or explicitly resume. |
| `/flow status ID` | `flow.status --run-id ID` |
| `/monitor events [--limit N]`, `/monitor watch` | Recent or streaming operation events. |
| `/adapter get` | Current adapter and diagnostics. |
| `/adapter validate --path FILE|--body JSON` | Validate candidate adapter. |
| `/adapter promote --path FILE|--body JSON` | Promote a validated adapter. |
| `/adapter rollback ID` | Roll back to an observed version. |

### Browser and low-level primitives

These belong in an expert section of slash help. References expire after every snapshot, and `surface` must be a dedicated auxiliary name where the operation accepts it.

| Slash command | RPC / flags |
| --- | --- |
| `/browser start [--headed|--headless]`, `/browser stop` | Managed/attached browser lifecycle. |
| `/browser open [--url URL|--conversation ID|--project ID|--gpt ID]` | Navigate the current account context. |
| `/browser mode headed|headless` | Guarded mode switch. |
| `/surface open --surface NAME --url URL`, `/surface activate --surface NAME`, `/surface close --surface NAME` | Auxiliary surfaces. |
| `/ui snapshot [--surface NAME]`, `/ui inspect [--surface NAME]` | Fresh observation and control inventory. |
| 🛑 `/ui click|focus|hover --ref N --epoch EPOCH [--surface NAME]` | Blind interaction with a live signed-in page: delete, share and settings controls all live there. Keep it on `--surface inspection`, read-only. |
| 🛑 `/ui fill --ref N --epoch EPOCH --text TEXT [--surface NAME]` | Fills a control on the live page. |
| 🛑 `/ui key --key KEY`, `/ui text --text TEXT`, `/ui mouse --x N --y N`, `/ui scroll --dy N` | Direct input primitives into his browser — Enter in the composer sends. |
| 🛑 `/ui upload PATH...`, `/ui viewport --width N --height N` | Upload puts a real local file into the page. |
| `/ui screenshot [--output PATH] [--surface NAME]` | Screenshot bytes or private file output. |
| `/map scan [--surface NAME]`, `/map network`, `/map request ID`, `/map response ID` | Observed surface/network evidence. |
| 🛑 `/api request --path /backend-api/... [--method METHOD] [--body JSON] [--binary]` | **The highest blast radius in the client.** Any method, any `/backend-api/` path, any JSON body, his live bearer token, no method or path allowlist and no confirmation. Operations this page calls "unimplemented" — conversation delete among them — are one `--method` away. Read-only `--method GET` on an already-observed route only; anything else needs his explicit word for that exact path and body. |

## Local CLI commands that slash help should mention

These do not belong in the service RPC registry:

- `accounts list`, `accounts use ID`, `accounts add ID` with `--label`, `--profile`, `--browser`, `--cdp`, `--workspace`, `--source`, or `--reference`.
- `browsers` for installed-browser discovery.
- `autostart install|status|uninstall`.
- `setup`, `doctor`, and `install`.
- `login`, `tui`, `help`, and the private `_daemon` entrypoint. `_daemon` should stay out of normal slash completion.

## Capability-map omissions

### Implemented operations missing or only indirectly represented

The slash registry must use the service switch as its operation source, rather than treating `capabilities.ts` as an exhaustive command registry.

- `conversations.unshare` is **routed but not implemented** (corrected 2026-09-16): `service.ts` dispatches it, yet `ConversationActions.manage` has no `unshare` label and throws *"Unsupported conversation action: its website flow has not been observed."* before clicking anything. The capability map's `unmapped` label is the accurate one; the registry entry is a stub. There is no way to revoke a share from this client.
- Local `accounts use` and `browsers` implement account switching and browser discovery outside RPC, while `account.switch` and `browser.discover` appear unmapped.
- Generic settings operations exist: `settings.get`, `settings.instructions`, `settings.open`, `settings.map`, and `settings.set`. Individual `settings.*` section capability IDs remain semantic scopes, not separate typed operations.
- Additional implemented reads/lifecycle operations absent as exact map entries: `conversations.cached`, `account.get`, `features.list`, `pins.list`, `browser.open`, `browser.stop`, `adapter.get`, `monitor.events`, `dictation.stop`, `dictation.controls`, and `audio.outputs`.
- Implemented expert primitives absent as exact map entries: `surface.open|activate|close`, `ui.inspect|click|focus|hover|fill|key|text|mouse|scroll|viewport`, `map.network|request|response`, and `api.request`.

### Catalogued but unimplemented typed capabilities

These names may appear in coverage, but slash completion must label them unavailable rather than dispatch an invented operation:

- **Conversations:** delete, move, report, read-aloud, feedback.
- **Website-native queue:** native queue and native steering. The durable CLI/TUI queue is local.
- **Projects:** create, rename, delete, instructions, files, sharing, memory, move-chat.
- **Health, Sites, Work, and Apps surfaces:** all typed actions currently unmapped.
- **Library:** open, folders, archived, trash, versions.
- **Images:** open, create, edit, archived. Image generation/download evidence does not create a typed image-create operation.
- **GPTs:** search, create, edit, publish, delete, knowledge, actions, version history.
- **Media:** typed image edit/create, video, camera, screen share, canvas, canvas export. The generic `media.images` and `media.audio` capability labels have no direct operation.
- **Tools:** search, deep research, agent, study, and apps. Connectors/plugins/scheduled-task listing is implemented separately.
- **Account:** workspaces and subscription as typed operations.

Settings section IDs and the five Health surface IDs are navigable/discoverable concepts, but current generic browser/settings primitives do not prove complete typed behavior for them.

## Coverage rule for slash commands

Every slash entry needs one of these outcomes:

1. A local TUI handler with a deterministic state transition.
2. An exact existing RPC operation and argument mapping.
3. An explicit `unimplemented` result naming the capability gap.

Unknown commands, missing required arguments, expired UI references, and unsupported aliases must fail before any browser action or message submission.

A fourth rule, added 2026-09-16: **an entry in this inventory is a capability record, never a grant.**
Before running any row that is not on the frozen-safe list above, the account owner must have asked for
that operation, in the current conversation, in his own words.
