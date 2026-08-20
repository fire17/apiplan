# The Eva annotation contract — a suspect turn is MARKED, never deleted

**Status:** in force from `src/talk.ts` on top of commit **`b64dd92`** ("E128: empty-transcript
noise gate cancels only its own segment's reply"), applied 2026-08-20 over the lane-15 working
tree (`src/talk.ts` md5 `d0423afcf6ea99947676e7379e50cdd3` at apply time; this repo has concurrent
writers — if HEAD moved before the commit landed, the commit message carries the real baseline and
this line is corrected in the same pass).
**Law it serves (fire17, sacred):** *the human is never censored.* A guard may FLAG a turn —
annotate the record, echo an info line — it may never drop, delete, or rewrite a turn that could
carry his words. And even when the model's context loses an item, **the log never does**.

---

## 1. Why a contract exists

The mouth's and the MIND's own sentences come back into the machine through the speakers. When
overlap recovery re-injects the archived window (`recoverOverlap → resendAudio`), those sentences
transcribe as `ev:"you"` — the system quoting itself back as the human. Seven such turns are
confirmed across three live calls (12600, 61139, 44292).

The tempting fix — delete the turn — is the one thing that must never happen on similarity alone,
because `conversation.item.delete` removes a WHOLE item and a recovered item can be **mixed**.
Observed, 44292 @ 15:05:38:

> `יודע מה המשפט האחרון שנאמר. ולגבי התיקון?`

Both clauses appear verbatim inside the MIND line spoken at 15:04:36 — the transcript scores
**1.000** against it, and stripping what we said leaves **nothing**. Text evidence cannot tell this
apart from a pure echo. Only the clock can: the turn ran **6162 ms** while the audio resent into it
was **3300 ms**, so live speech was inside it. That is why deletion needs four independent
agreements — and why, even after all four agree, the turn is still written to the log.

---

## 2. The four belts

| belt | signal | source |
|---|---|---|
| **item** | `ev.item_id === recoveredItemId` — the id the server gave the item it built from the RESENT audio (`input_audio_buffer.committed`, first commit after the resend committed) | server event |
| **text** | `echoScore(t)` — best bigram-Dice over a sliding SAME-LENGTH window of anything in `recentSpoken` (last 6 spoken lines). `≥ 0.75` on the recovery path, `≥ 0.90` for a live turn (and only ≤45 s old) | transcript only |
| **timing** | `bulkAppended` — an `audio resent (Xs)` committed ≤2 s before **this turn's own** `speech_started`, and `resent_ms − speech_ms > 1500` | log-visible state only |
| **residual** | `infoFree(echoResidual(t, src))` — strip every clause our own speech explains (never a clause under 4 normalized chars: `כן` is an ANSWER, not an echo); what remains must be **empty** | transcript + matched line |

The **item belt** is what keeps the whole machine off his live speech. The old code inferred
"recovered" from a process-global 20 s window (`suppressRestoreAt && recoverSentAt`), so the first
transcript to land inside it claimed the recovery path — his live turn included, judged at the
loose bar with the power to delete. Recovery is now an item identity. If the commit event never
arrives, nothing is bound and nothing is deletable: the belt degrades to flag-only, which is the
safe direction.

The **timing belt** is the one that knows a human was present, and it reads *this turn's* clock: at
`speech_stopped` the pair `{startedAt, ms}` is pushed onto a 4-deep FIFO and each transcript
consumes its own (an empty transcript consumes its own too — that is what keeps the ring aligned).
Reading the globals let one turn be judged with another's numbers: a brief live "אוקיי" landing
1.5 s after a long resend donates exactly the shape that makes a bulk-append look proven.

A resent turn is closed by the server's 1.1 s silence tail regardless of content length (measured
0.5–1.2 s of turn for 2.8–19.6 s of appended audio); a live turn cannot stop before the speech
inside it ends (every genuine turn in the corpus ran 2.98–104.73 s, n=31). The **1500 ms floor**
exists so a LONG resend cannot make a merged turn look bulk-appended on a bare `<`.

---

## 3. The rule

```
DELETE-FROM-CONTEXT  iff  item belt AND text belt AND timing belt AND residual is empty
FLAG                 iff  not deleted  AND  (text belt OR timing belt)
KEEP                 otherwise
```

`FLAG` changes nothing about the turn's life: it still prints as `ev:"you"`, still reaches the
model's context, still reaches the dashboard, still ends the user's turn. The only effects are
extra fields on its log record and one info line.

**`DELETE-FROM-CONTEXT` is not deletion of his words.** Before the `conversation.item.delete` is
sent, the turn is written with `say("you", …)` exactly as it was transcribed. The model's context
loses the item; the LOG, the `onEvent` stream and the dashboard keep it, carrying the evidence that
removed it. A wrong decision therefore costs a context entry — never a word.

---

## 4. The annotation, byte for byte

The annotation is **additive fields on the `ev:"you"` record itself** — never a separate event,
never a replacement. `say("you", text, extra)` spreads `extra` FIRST, so `ev` and `text` are
structurally impossible for an annotation to alter.

Flagged (kept in context):

```json
{"t":1787228738883,"echo_suspect":true,"echo_sim":1,"echo_belt":"text",
 "echo_recovered":true,"echo_residual":"","resent_ms":3300,"speech_ms":6162,
 "ev":"you","text":"יודע מה המשפט האחרון שנאמר. ולגבי התיקון?"}
```

Removed from the model's context (still recorded):

```json
{"t":1787228095304,"echo_deleted_from_context":true,"echo_sim":0.94,
 "echo_src":"…the MIND line it matched…","echo_recovered":true,
 "echo_belt":"text+timing+residual","resent_ms":2800,"speech_ms":605,
 "item_id":"item_…","ev":"you","text":"שאלתי אותם לאישור תזמון ואחזור עם תשובה סופית."}
```

| field | meaning |
|---|---|
| `echo_suspect` | present and `true` only on a FLAGGED turn; absent otherwise |
| `echo_deleted_from_context` | present and `true` only on a turn whose ITEM was deleted; the text above it is still the real transcript |
| `echo_sim` | best similarity against what we spoke, 2 decimals |
| `echo_belt` | which belts fired: `"text"`, `"timing"`, `"text+timing"`, `"text+timing+residual"` |
| `echo_recovered` | the turn is the item built from the resent audio |
| `echo_residual` | what our own speech does NOT explain, first 200 chars (empty ⇒ fully explained; always empty on a timing-only flag, where nothing was ever explained) |
| `echo_src` | the spoken line the transcript matched, first 200 chars (deleted turns only — the evidence) |
| `resent_ms` | length of the last resend that could explain this turn |
| `speech_ms` | `speech_stopped − speech_started` **of this turn** |
| `ev` / `text` | **unchanged** — byte-identical to the transcript, with or without a flag |

Plus one human-visible `ev:"info"` line per decision:

- flag → `possible speaker echo — turn FLAGGED, not removed (text/—, residual kept)`
- delete → `recovered turn was speaker echo — removed from the model's context, KEPT in the log (sim 0.94, resent 2800ms vs turn 605ms, no residual)`
- binding → `recovered audio committed as item_…`
- gate → `overlap recovery skipped — nothing above the leak bar (100ms loud, 150ms isolated in the 400ms teardown tail — held)`

The bars line now records every threshold in force:
`bars: barge=1800/250ms recover=2000 tail=400ms echo=0.75/0.9 mutedwarn=1800`.

---

## 5. How Eva reads it

1. Render the turn. Always. Neither `echo_suspect` nor `echo_deleted_from_context` is a reason to
   hide a line — the second one means the MODEL stopped seeing it, not that he stopped saying it.
2. Mark it visually — badge, muted tint, tooltip carrying `echo_belt`/`echo_sim`/`resent_ms`/
   `speech_ms`. The operator decides, not the belt.
3. Never fold, merge, or summarize a flagged turn away — it may be mixed, and the human half may be
   the important half.
4. Never write an `echo_suspect` of its own, and never act on `item_id` beyond correlation.
5. Counting: a flagged turn still counts as a turn in every metric. If leak-free statistics are
   wanted, report them as a *second* number beside the true one, never in place of it.
6. **For readers that build the MIND's context from the log** (bridges, summarizers, anything that
   answers as if it heard him): a turn carrying `echo_deleted_from_context: true` is our own voice
   coming back — reason as if it were not said, exactly as the realtime model now does. Filter it
   out of *reasoning*, never out of the *record*. That split is the whole point of writing it: the
   evidence stays inspectable, and a wrong call costs a context entry rather than his sentence.

The hub passes the rendering fields through its whitelist copy at `hub/hub.ts:284`
(`events.push({ … ev: "you" … })`). **W9 collision note:** that file is owned by the observatory
lane; the passthrough was applied with an in-pass `grep -cF == 1` (md5 `ae1de2a4…`, quiet since
15:36) and W9 must carry it forward if it rewrites `splitCall`. If the passthrough is ever lost,
nothing breaks — the annotation still rides the raw call log; only the dashboard badge goes dark.

---

## 6. Invariants (any change to the belts must preserve all seven)

1. **No live turn is ever deleted.** Deletion requires the item id the server assigned to the
   resent audio.
2. **No turn with unexplained words is ever deleted.** Deletion requires an EMPTY residual, and a
   clause under 4 characters is never treated as explained.
3. **No turn that outlasts its own resend is ever deleted.** Deletion requires the timing belt with
   its 1500 ms floor, computed from that turn's own speech pair.
4. **Nothing he said ever leaves the log.** A deleted item is written with `say("you", …)` first.
5. **A flag never suppresses.** The flag branch contains no `break`, no `return`, no
   `conversation.item.delete`.
6. **The annotation is additive and cannot overwrite.** `rec({ ...extra, ev: kind, text })` —
   canonical fields last.
7. **Every belt is log-derivable.** Everything the rule uses appears in the call log, so any
   decision can be re-audited afterwards from the log alone.

---

## 7. Measured behaviour

Replayed 2026-08-20 with the SHIPPED expressions (the harness slices the belt text verbatim out of
the patched file and asserts eight decision expressions are present), three live calls, 50
`ev:"you"` turns, log clock driving the age window:

| outcome | count | turns |
|---|---|---|
| DELETE-FROM-CONTEXT | 6 | `12600@13:53:42` 0.990 · `61139@13:47:17` 0.886 · `61139@13:50:40` 0.959 · `44292@15:08:00` 0.793 · `44292@15:14:55` 0.943 · `44292@15:26:58` 0.982 — all item-bound, all residual-empty, resend 4–16× the turn |
| FLAG | 3 | `44292@15:02:51` (proven echo; timing floor not met — 1500 ms resent vs 558 ms turn) · `44292@15:05:38` MIXED (6162 ms turn vs 3300 ms resent) · `44292@15:10:46` timing-only |
| KEEP | 41 | every genuine human turn; highest similarity on a kept turn **0.494** |
| **human words lost** | **0** | including the mixed turn, and including all six deletes (each keeps its `ev:"you"` record) |

Assertions, all passing: emitted `ev:"you"` byte-identical to `transcript.trim()` on every turn;
no delete of a turn outside the proven-echo list; no delete of a non-recovered turn; no delete with
a surviving residual; every deleted turn carries its `say("you")` record.

**Teardown gate**, byte-exact on S3's real window (`turn-016-1787228033278.wav`, 34.20–54.60 s):

| TAIL_MS | loudMs | held in tail | verdict |
|---|---|---|---|
| 0 (shipped defect) | 250 | 0 | RECOVER |
| 150 | 250 | 0 | RECOVER |
| **400 (default)** | **100** | 150 | **SKIP** |

and on synthetic windows: a 300 ms onset entirely inside the tail → folded back, **RECOVER**,
resend window untruncated (0.60–1.20 s of a 1.20 s window); speech from 0.2 s running into drain →
**RECOVER**, 0.00–1.20 s; a lone 100 ms click → **SKIP**.

**Residual belt**, against a MIND line containing "כן":

| transcript | residual | delete-eligible now | delete-eligible under the old <12-char rule |
|---|---|---|---|
| leak sentence + `כן` | `"כן"` | no | **yes** |
| leak sentence + `תעצור` | `"תעצור"` | no | **yes** |
| leak sentence + `ולגבי התיקון?` | `"ולגבי התיקון?"` | no | no |
| pure leak | `""` | yes | yes |

**Cost** (runs synchronously in `ws.onmessage`): real corpus mean **0.43 ms**, worst **1.65 ms**;
synthetic worst (ring of 6 × 2000-char lines, 600-char turn) **2.28 ms**; **0.008 ms** when leak is
impossible (empty ring, or a ring whose newest line is older than the window).

**Build/typecheck:** `bun build --target=bun` clean (4 modules, 68.26 KB); `tsc 5.6.3 --strict`
error multiset byte-identical to the baseline file — zero new type errors.

---

## 8. Honest limits

1. **The item binding is unverified against this corpus.** The call log records
   `{"ws":"input_audio_buffer.committed"}` without `item_id`, so the replay stands in for the
   binding with "the first transcription that completes after the resend commits" — the same turn
   the binding names in every observed sequence, but not a proof. The new
   `recovered audio committed as item_…` info line is what makes the binding auditable from the
   next live call onward.
2. **The corpus predates the shipped belt** (all three calls ran engines older than `12a4f9e`), so
   these numbers are a faithful **simulation** over real audio and real logs. One live call showing
   `recovered turn was speaker echo — removed from the model's context` settles it.
3. **One shape no belt here separates:** a mixed item whose human half is *also* something we
   recently said, arriving inside a long resend. It would be deleted from context — and, since
   invariant 4 holds, still recorded in full. No instance exists in this corpus.
4. **Not fixed, out of lane:** the mic archive runs at 0.899 × wall clock while `archHeader` stamps
   24000 Hz, so every `overlap-*.wav` replays ~11 % fast and pitch-shifted — the likely cause of the
   garbled recovered transcripts (`hevan`, `olip.`, `İşima?`). Probe before coding:
   `ffmpeg -f avfoundation -i :default -ac 1 -ar 24000 -f s16le -t 10 -` and weigh the bytes against
   480000.
