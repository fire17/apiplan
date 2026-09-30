# OpenCode Zen, under the hood

What the `zen` provider is, and where every sentence here was read from. Written for the
port in `src/providers-zen.ts` + the rate card in `src/roster.ts`, 2026-09-12.

**Every claim below carries its needle** — a file, a byte offset, a table row — because the
one thing this document must not become is a description that reads like a measurement.
Quotes from the opencode binary are byte-exact from the embedded JavaScript source; they
were re-read for this file rather than copied from the brief that started the lane (which
turned out to carry four offsets that do not resolve — see *Corrections*).

Nothing here was obtained by dialling opencode.ai. **There is no OpenCode Zen credential on
this machine**, which is also why the whole port is stub-proven only (see *The one question
a key settles*).

---

## 1. The client that defines the route

| fact | value | needle |
|---|---|---|
| binary | `~/.opencode/bin/opencode` | `file(1)`: Mach-O 64-bit executable arm64; 144,272,354 bytes, mtime 2026-09-09 06:17 |
| version | `1.18.30` | `opencode --version` |
| source | JavaScript, embedded uncompressed in the binary | every quote below is a byte range of that file |

The catalog it serves from is a second artefact, on disk beside it:
`~/.cache/opencode/models.json` (4,623,774 bytes, mtime 2026-09-12 13:35) — opencode
rewrites it, so it is a moving source and `test/roster.test.ts` re-reads it on every run.

## 2. The provider entry

Embedded in the binary's provider table at **byte 71,568,931**, verbatim:

```js
opencode:{id:"opencode",env:["OPENCODE_API_KEY"],npm:"@ai-sdk/openai-compatible",
          api:"https://opencode.ai/zen/v1",name:"OpenCode Zen",doc:"https://opencode.ai/docs/zen",models:{…}}
```

The same table carries a sibling `opencode-go` (`https://opencode.ai/zen/go/v1`), which this
port does not touch.

`npm` is the provider-level DEFAULT dialect, and it is overridden **per model**. Inside the
catalog transform quoted in §3:

```js
let x = y.provider?.npm ?? m.npm, w = ft.get(x);
```

So a model's own `provider.npm` decides which SDK dialect speaks to it. Counted from
`~/.cache/opencode/models.json`, `opencode.models` (102 ids):

| `provider.npm` | ids | apiplan status |
|---|---|---|
| `@ai-sdk/openai` (Responses) | **28** | ported — 26 paid ones listed, 2 free ones hidden |
| `@ai-sdk/anthropic` | 20 | not addressable |
| `@ai-sdk/google` | 8 | not addressable |
| absent → `@ai-sdk/openai-compatible` (chat completions) | 46 | not addressable |

That 28 is the reason this lane ports the Responses dialect and nothing else: Muse Spark is
in it, and `src/responses-wire.ts` already speaks it.

## 3. What a key is, and what happens without one

At byte **72,673,486**, verbatim:

```js
let p = Boolean(process.env.OPENCODE_API_KEY || a || f.provider.request.body.apiKey);
if (s.provider.update(f.provider.id, (u) => { if (!p) u.request.body.apiKey = "public" }), p) return;
for (let u of f.models.values()) {
  if (!u.cost.some((m) => m.input > 0)) continue;
  s.model.update(f.provider.id, u.id, (m) => { m.enabled = !1 })
}
```

Read it as three facts:

1. **The key wells** are `OPENCODE_API_KEY`, an active `opencode` integration connection
   (`a`, resolved just above from the auth store — method `{type:"key", label:"API key
   (service account)"}`), or an apiKey already planted in the request body.
2. **With no key, opencode sends the literal string `public`** as the API key.
3. **With no key, every PAID model is DISABLED** (`cost.input > 0` → `enabled = false`).
   Which is precisely why the only zen conversation in evidence on this box ran on a
   `-contributor-free` id (§6): the paid ones were switched off in that client.

On this machine, today:

```
~/.local/share/opencode/auth.json   →  one entry: "google" (type oauth). No "opencode" key.
$OPENCODE_API_KEY                   →  unset
~/.zshrc, ~/.zshenv, ~/.zprofile    →  0 occurrences of OPENCODE_API_KEY
```

(Read for SHAPE only — provider names and the `type` field. No key material was read,
printed or stored by this lane; the provider prints at most `sha256(key)[:12]`.)

## 4. The headers opencode stamps — and why apiplan sends none of them

At byte **65,841,546**, verbatim:

```js
headers:{ ...e.model.providerID.startsWith("opencode") ? {
            ...k ? {"x-opencode-project": k} : {},
            "x-opencode-session": e.sessionID,
            "x-opencode-request": e.user.id,
            "x-opencode-client": e.flags.client,
            "User-Agent": _i
          } : { "x-session-affinity": e.sessionID, "X-Session-Id": e.sessionID, "User-Agent": _i },
          ... }
```

Four `x-opencode-*` headers plus a User-Agent, stamped only when the provider id starts with
`opencode`. They are that CLIENT's identity.

**apiplan sends none of them, by decision**, and `test/zen.test.ts` (T4/S7) turns adding one
into a red test. The reason is §7.

## 5. Usage and cost, as opencode itself computes them

The token writer, byte **67,539,101**, verbatim:

```js
Y=K(Q.usage.inputTokens??0), W=K(Q.usage.outputTokens??0), H=K(Q.usage.reasoningTokens??0),
Z=K(Q.usage.cacheReadInputTokens??0), J=K(Number(Q.usage.cacheWriteInputTokens ?? …0)),
V=K(Y-Z-J),
z={total:Q.usage.totalTokens, input:V, output:K(W-H), reasoning:H, cache:{write:J, read:Z}},
F=Y,
R=Q.model.cost?.tiers?.filter((G)=>G.tier.type==="context" && F>G.tier.size)
        .sort((G,B)=>B.tier.size-G.tier.size)[0]
   ?? (Q.model.cost?.experimentalOver200K && F>200000 ? Q.model.cost.experimentalOver200K : Q.model.cost)
```

and the price, immediately after it:

```js
cost = z.input*R.input/1e6 + z.output*R.output/1e6
     + z.cache.read*R.cache.read/1e6 + z.cache.write*R.cache.write/1e6
     + z.reasoning*R.output/1e6
```

Three consequences this port depends on:

* **The basis is INCLUSIVE.** `V = Y - Z - J` — the client subtracts the cached and written
  share out of `inputTokens`, which is only meaningful if `input_tokens` already contains
  both. That is what `PROVIDERS.zen.usageBasis = "inclusive"` declares, and
  `test/provider-cache-contract.test.ts` pins it to this quote.
* **Reasoning is billed at the OUTPUT rate, in addition to the visible output.** The stored
  `output` is already net of reasoning (`K(W-H)`), and the cost line then adds
  `z.reasoning * R.output` back. So the billable output of a turn is the wire's
  `output_tokens`, reasoning included.
* **The long-context tier is STRICT** (`F > G.tier.size`), compared against the INCLUSIVE
  input total, and the largest matching tier wins. `src/roster.ts`'s `zenTier` therefore
  emits no `inputThresholdInclusive` — parity with this arithmetic rather than a guess at a
  silent page. The residual doubt is stated in that file: this is the CLIENT's estimator,
  not opencode.ai's invoice.

The catalog→cost mapper (near byte **67,440,793**) is where a `cost` block becomes that `R`:

```js
{input, output, cache:{read: cache_read??0, write: cache_write??0}}
+ tiers: cost.tiers.map(…{input, output, cache:{read,write}, tier})
+ experimentalOver200K  ← from the catalog's `context_over_200k`
```

`src/roster.ts` reads the same three shapes out of the same file.

## 6. The one real zen conversation in evidence

`~/.local/share/opencode/opencode.db` (SQLite, 8,171,520 bytes, opened **read-only**).
Schema only: `message(id, session_id, time_created, time_updated, data)` with `data` a JSON
blob carrying `providerID`, `modelID`, `cost`, and
`tokens{total,input,output,reasoning,cache{read,write}}`.

Rows with `providerID = "opencode"`: 227. Of those, **33 are `muse-spark-1.3-contributor-free`**,
all on **2026-09-09, 11:13:22 → 11:33:18**, and **every one of them cost 0** — total cache
read across the 33: **1,455,136 tokens**. (No message CONTENT was read; the sweep touched
`modelID`, `tokens` and `cost` only.)

The row the fixtures are built on, 2026-09-09 **11:32:54**:

```json
{"total": 134660, "input": 889, "output": 3307, "reasoning": 1583, "cache": {"read": 128881, "write": 0}}
```

Undo §5's subtractions and the wire turn was `input_tokens 129,770` / `output_tokens 4,890`
— and `129,770 + 4,890 = 134,660`, the vendor's own `totalTokens`, exactly. That closure is
the corroboration for the inclusive basis.

**One thing this does NOT settle, stated out loud.** The same relation fails on the 11:13:22
row of the same conversation: stored `{total 131796, input 131176, output 507, reasoning 417,
cache.read 113}` → wire `131,289 + 924 = 132,213`, against a stored total of 131,796, which
closes only if reasoning is INSIDE output there. Both totals are the vendor's own field, so
`total` is not a reliable cross-check across rows; the subtraction in the writer is. A keyed
live turn settles it.

## 7. The decision: the key route is ported, the free tier is not

The planner of this lane probed `POST https://opencode.ai/zen/v1/responses` twice with
`Authorization: Bearer public` and recorded (their observation, not this builder's — no
request to opencode.ai was made from here):

```
HTTP 400
{"type":"MissingSessionID","message":"Error from provider (Console): OpenCode's free tier can only be used in OpenCode"}
```

Put beside §3 and §4, the picture is consistent: without a key opencode's own client sends
`Bearer public`, the paid ids are switched off locally, and the free ids are served only to
a caller that also carries `x-opencode-session`.

**So:**

* **Ported** — the documented key route: `Bearer <OPENCODE_API_KEY | auth.json["opencode"].key>`,
  Responses wire, the 26 paid Responses-dialect ids, priced from the vendor's own catalog.
* **Not done, and not a builder's call** — sending `x-opencode-session` / `x-opencode-client`
  from apiplan. It would very likely make the free tier answer; it is also exactly what the
  vendor's sentence forbids, and it works by wearing another client's identity. That is
  fire17's decision to make, not a patch to slip in. `test/zen.test.ts` asserts no
  `x-opencode-*` header is ever sent and that the string `Bearer public` never leaves this
  process, so the choice cannot drift silently.
* **A separate lane, if the free tier is wanted legitimately** — drive his LOCAL opencode as
  the client and read usage from its own records. It does not satisfy "available to anyone
  using apiplan", and since every such turn costs 0, "correct cost calculations" would be
  vacuous there.
* **Follow-up lanes** — the 46 chat-completions ids, the 20 anthropic-dialect ids, the 8
  google-dialect ids. `apiplan models --refresh` prints those three counts so the gap stays
  visible instead of being mistaken for the whole port.

## 8. The one question a key settles

Everything above is disk evidence; the wire is proven only against a recorded stub. With a
key (`opencode auth login`, or `OPENCODE_API_KEY`), one 2-turn conversation answers all of
what is still open, and the receipt belongs at `.deify/zen/receipt.json` (key sha256 prefix
only, never a key byte):

1. Does a **keyed** call succeed without `x-opencode-session`? If it also answers
   `MissingSessionID`, **stop** — that is a finding for fire17, not a licence to spoof a
   header.
2. Does zen honour `prompt_cache_key`, i.e. does turn 2 report `cached_tokens > 0`? The
   provider declares that identity at the outbound boundary only; nothing here proves the
   backend routes on it.
3. Does the invoice agree with §5's strict tier at the boundary token, and is reasoning
   billed as output there too?

Until then, every zen claim in this repo reads **LIVE UNVERIFIED — stub-proven only**.

## 9. Reasoning efforts through a harness

OpenCode's catalog advertises `none` as a reasoning effort on ten gpt-5.x ids
(`src/providers-zen.ts` ZEN_FALLBACK, and the same value arrives from the live catalog via
`catalogEfforts`). apiplan sends it when asked (`-e none`, `bin/apiplan.ts`
RESPONSES_EFFORTS), but OM's `models.yml` schema accepts only
minimal/low/medium/high/xhigh/max — and its arktype validator rejects the WHOLE file on one
level outside that set, which emptied `providers` and took every apiplan model out of the
picker. So `apiplan roster omp` narrows every ladder to that set at the harness boundary
(`src/roster.ts` `OM_EFFORTS` / `harnessEfforts`); through OM those ids run without `none`,
and an id that advertised only `none` would show no thinking control at all
(`reasoning: false`, no `thinking:` block) rather than an empty list OM would also refuse.
The catalog itself is untouched: apiplan's own wire keeps the vendor's full list.

## Corrections to the brief this lane was given

Recorded rather than silently fixed, because the same numbers may travel again:

* **Four byte offsets do not resolve.** The brief cited 9,339,437 / 7,193,302 (usage
  mapping), 15,529,646 (key resolution) and 8,698,307 (headers). At those addresses this
  binary holds ARM machine code, not source. The CLAIMS were all correct; the needles were
  not. This document uses offsets re-found by string search and re-read here (67,539,101 /
  72,673,486 / 65,841,546 / 71,568,931 / 67,440,793).
* **`muse-spark-1.1`, `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` do not
  exist** in today's catalog. The muse family is exactly four ids: `1.2`,
  `1.2-contributor-free`, `1.3`, `1.3-contributor-free` — two paid, two free.
* **The priced fixture was 19.5% low.** The brief priced the DB's `output` (3,307), which is
  already net of reasoning, at $0.034498. Pricing the wire's 4,890 the way §5's cost line
  does gives **$0.0412259** for that turn. (The briefed figure is also 1.5e-7 away from its
  own stated tolerance of ±1e-9.) `test/roster.test.ts` asserts both numbers, so the trap
  cannot come back quietly.
