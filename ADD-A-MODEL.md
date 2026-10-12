# Add a new model — the 5-minute path

A new model (say Anthropic ships **Claude Fable 6**, id `claude-fable-6`) usually needs
**no code**: the provider's own list endpoint already carries it, and the registry's parser
already understands the family. You only refresh, check, call, and (to ship it to fresh
installs) bake it into the snapshot.

The daily report tells you when this is due: `reports/catalog/YYYY-MM-DD.md`, written at
09:30 by `scripts/catalog-daily.ts` (launchd `com.fire17.apiplan-catalog-daily`). It lists
NEW / GONE / CHANGED per provider, anything the parser cannot address, and anything live
but missing from the baked snapshot. It never changes the live catalog.

## 1. See it (read-only)

```sh
bun scripts/catalog-daily.ts --stdout      # is it NEW? is it "unaddressable"?
```

## 2. Make it resolve on this machine

```sh
apiplan models --refresh --provider anthropic   # rewrites ~/.apiplan/models.anthropic.json
apiplan models anthropic                        # the new row + the aliases that reach it
```

A refresh moves alias resolution: if Fable 6 is the newest Fable, `fable` now means it, for
every shim, `apiplan serve` and the MIND. That is the point, and also why step 4 runs right
after.

## 3. Only if the report says "unaddressable" — teach the parser

The parser per provider is in `src/registry.ts` (`parseAnthropic`, `parseOpenai`,
`parseGoogle`, … in `PARSERS`). Anthropic's matches
`^claude-(opus|sonnet|haiku|fable|mythos)-…`, so a brand-new FAMILY name (not a new version)
is the only Anthropic case that needs a one-word edit there and in `anthropicFallback()`'s
family list. Add a test row beside `test/catalog-sweep.test.ts`.

Voice/realtime ids are not in a list endpoint: they live in `LIVE_MODELS`
(`src/live-models.ts`) and need a live turn proven before they join (see commit 6d639c7).

## 4. Prove it

```sh
bun bin/ask.ts -m claude-fable-6 say only OK   # one tiny real call through the subscription
bun bin/ask.ts -m fable say only OK            # the family alias now lands on it
bun test                                       # the suite, after the refresh
apiplan doctor                                 # no command points at a model that vanished
```

## 5. Ship it

1. Bake it into the offline snapshot: add the row to `FALLBACK.<provider>` in
   `src/registry.ts`, newest first, with a comment saying where and when it was read live
   (e.g. `// read live from /v1/models 2026-10-12`). This is what a fresh install sees
   before its first refresh.
2. If it is a headline model: a line in `README.md`'s model section and `CHANGELOG.md`.
3. Commit only those paths (`git commit <paths>`), never `git add -A`. Pushing is a separate,
   approved step.
4. `models()` in `src/registry.ts` re-reads the cache file on every lookup (no in-memory
   copy), so a refresh should reach a running `apiplan serve` without a restart; check with
   one call to the server. A code change (parser, `LIVE_MODELS`) needs
   `apiplan hotswap upgrade`, which is a live-server action: only when the lane allows it.

## Harness updates (Claude Code, Codex)

The daily report says UPDATE AVAILABLE yes/no and the exact command per install. **Do not
run it without Tami's approval.** `~/.ucode/bin/claude` is a patched clone: updating it
means re-forging from the new stock binary, never a plain upgrade. A newer Codex can unhide
OpenAI catalog models (the catalog is gated by client version); `apiplan models --refresh`
already asks as the newest Codex it knows of, so the catalog side does not wait on the
harness update.

## Proposed one-command helper (not built)

```sh
apiplan models add anthropic claude-fable-6
```

would do steps 2–4 in one go: refresh that provider into a shadow dir, confirm the id is
listed and parseable, make one `say only OK` call, print the resolved aliases, and print
the exact `FALLBACK` row to paste for step 5. It writes the live cache only after the call
succeeds. Not built yet: the shadow-refresh half already exists in
`scripts/catalog-daily.ts`, so this is roughly a 60-line subcommand when wanted.
