# LADDER — information architecture for `apiplan`

Medium: **terminal** (headless CLI + an interactive TUI over the same functions).
Tone source: no design tokens exist for a terminal; the convention source is this
project's own output grammar — one status glyph per row (`●` green/amber/red), dim for
secondary text, bold for the thing you act on, columns sized from content, ANSI disabled
under `NO_COLOR` or when stdout is not a TTY.

## Ground inventory (observed, not imagined)

| Entity | Real source | Volume here |
|---|---|---|
| Provider | `security find-generic-password` (macOS) / `~/.claude/.credentials.json`; `~/.codex/auth.json` | 2 |
| Model | Anthropic `GET /v1/models` (11 live) · Codex `models_cache.json` (7, 1 not addressable) | 17 |
| Command | `~/.apiplan/commands.json` + the shims actually on `PATH` | 13 |
| Daemon | unix socket / loopback port file in `~/.apiplan/` | 0 or 1 |

Evidence for needing more than one altitude, taken from this build: the `gpt` command was
silently shadowed by `/usr/sbin/gpt` for an entire session (a *command*-level fact),
`opus` pointed at 4.8 when Opus 5 existed (a *model*-level fact), and a call failed
because a token had expired (a *provider*-level fact). Three different questions, three
different object vocabularies — so three rungs, not one screen.

## Task per altitude

| Rung | Question it answers | Decider | Objects |
|---|---|---|---|
| 1 · system | "Can this machine call models right now?" | the person at the shell | providers, daemon, command roster |
| 2 · models | "Which model do I want, and what do I type to reach it?" | same | models + their aliases + effort levels |
| 3 · commands | "What does each command of mine do, and is it reachable?" | same | commands (name → model + baked flags + PATH health) |

Objects are disjoint between rungs (providers → models → commands), so each rung is a
re-representation, not a zoomed-out copy of the one below (Law 1).

## Rung specs

```yaml
- rung: system
  vocabulary: [provider, daemon, command-roster]
  new_objects: [provider, daemon]
  dropped: [per-model detail, per-command flags]      # named in-view: "13 in ~/.bun/bin"
  representation: status list, one line per provider + a roster line
  fields:
    - connected:   {from: provider.probe(), locator: keychain | ~/.codex/auth.json}
    - detail:      {from: probe, shows: source + expiry + plan}
    - loginHint:   {from: probe, shown only when disconnected}   # derived, marked with →
    - models:      {from: registry cache, locator: ~/.apiplan/models.*.json}
  actions: [install-defaults(i), refresh-models(R), daemon-start/stop(D)]
  selection: single provider (↑↓)
  reversibility: install is idempotent; daemon stop/start is symmetric

- rung: models
  vocabulary: [model]
  new_objects: [model, alias, effort-level]
  dropped: [provider credential detail]
  representation: table — model id · aliases · effort levels
  fields:
    - id:       {from: provider model list, locator: /v1/models | models_cache.json}
    - aliases:  {derived: family | family+version | variant}   # bold id = owns the family alias
    - efforts:  {from: provider-advertised levels, not hardcoded}
  actions: [make-command-from-model(c), refresh(R)]
  selection: single model (↑↓)
  reversibility: created command is removable with rm

- rung: commands
  vocabulary: [command]
  new_objects: [command, baked-flags, PATH-health]
  dropped: [model catalogue, provider credentials]
  representation: table — glyph · name · model → resolved id · flags
  fields:
    - name:      {from: ~/.apiplan/commands.json}
    - model:     {from: config, resolved live so `opus` follows the newest Opus}
    - flags:     {from: config}
    - health:    {derived: installed? on PATH? which file wins}   # ● / ● / ●
  actions: [new(n), rename(r), edit-flags(f), delete(d), sync-all(s)]
  selection: single command (↑↓); `sync` acts on the whole set
  reversibility: config is plain JSON — undo is an edit plus `apiplan sync`; delete confirms first
```

## The glue

- **Zoom:** keys `1` / `2` / `3`; the current rung is underlined in the header, so the
  altitude is legible in one glance (Law 8). Every rung also has a headless twin
  (`apiplan status` / `models` / `commands`) — no rung is reachable only through the TUI.
- **Lateral:** `↑↓` moves between peers at the same altitude.
- **Compression cue:** each rung names what it is not showing (`13 in ~/.bun/bin`,
  `6 models, just now`), so dropped information is visible as a count, never invisible.
- **Down:** rung 2's `c` (make a command from this model) and rung 3's model column carry
  focus across the zoom — the object you selected is the object that lands.
- **Edit at altitude:** rename / flags / delete are edits made at the command rung that
  propagate to ground truth (the shim files on PATH) through one `sync`, and the result is
  re-read and re-displayed immediately, so what you see is the new disk state.

## Budgets

Terminal-appropriate, and enforced in `BUDGETS.md`: any rung renders in **< 60 ms** with no
network (all reads are local JSON, measured at 0.01 ms), the network only ever runs on an
explicit `R` / `--refresh`, and a stale cache says so (`never refreshed`, `3h ago`,
`stale — apiplan models --refresh`) rather than pretending to be fresh (Law 9 over latency).

## Acceptance matrix

Tests a–g run against the live surface. Evidence = the command that shows it.

| Rung | a. one question | b. re-representation | c. drops visibly | d. real action | e. reversible | f. from this project's evidence | g. altitude legible |
|---|---|---|---|---|---|---|---|
| system | PASS — "can I call models?" | PASS — providers/daemon exist at no other rung | PASS — roster count + model count | PASS — install, refresh, daemon | PASS — idempotent / symmetric | PASS — the expired-token failure | PASS — header + `apiplan status` |
| models | PASS — "what do I type?" | PASS — models ≠ providers | PASS — `just now` / `stale` | PASS — `c` creates a command | PASS — `rm` removes it | PASS — `opus` pointed at 4.8 | PASS — header + `apiplan models` |
| commands | PASS — "what does mine do?" | PASS — commands ≠ models | PASS — bin dir + health glyphs | PASS — new/rename/flags/delete | PASS — JSON + sync; delete confirms | PASS — `gpt` shadowed by `/usr/sbin/gpt` | PASS — header + `apiplan commands` |

**Rung graveyard** (rejected rather than faked):

- **"usage / spend" rung** — the obvious fourth altitude (calls per day, tokens, cost).
  Dropped: this tool keeps no call log, and the subscription exposes no per-call price, so
  every field would have been synthetic. Padding a rung with invented data is explicitly
  banned; if a real log is ever added, the rung earns its place then.
- **"conversation history" rung** — each call is stateless by design (`store: false` on
  OpenAI). There is no ground truth to zoom into, so the rung would have been decoration.

**NOT yet live-verified:** the TUI's interactive key handling has been exercised by hand on
macOS only; Windows Terminal and Linux consoles are covered by the platform tests and the
forced-TCP transport run, not by a real interactive session on those OSes.
