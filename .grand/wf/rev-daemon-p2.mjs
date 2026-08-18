export const meta = {
  name: 'rev-daemon-p2',
  description: 'Warm talk daemon: offline park test via mock.module, adversarial review, doctor integration',
  phases: [
    { title: 'Harden', detail: 'offline park test + adversarial review + doctor park row' },
  ],
}

const ROOT = '/Users/magic/Creations/APIPlan'

const SHARED = `
You are a lane inside the APIPlan "warm talk daemon" build (project root ${ROOT}).

WHAT WAS JUST BUILT (read these before anything else):
- ${ROOT}/src/talk-daemon.ts  — NEW. The park manager + the POST /talk route handler + the
  thin-CLI client. Read it end to end; it is the subject of this phase.
- ${ROOT}/src/engine.ts       — runDaemon() now routes POST /talk and GET /talk/status into
  talk-daemon.ts, warms api.openai.com, and calls shutdownPark() on exit.
- ${ROOT}/bin/apiplan.ts      — \`apiplan talk\` now tries the daemon first and falls back to
  the in-process path; \`--direct\` forces direct, \`--park\` pre-warms.
- ${ROOT}/VOICE_UPGRADE_PLAN.md — the oracle. Read the "measured latency truth" and "Do-NOT"
  sections so you do not re-propose a known dead end.

THE IDEA IN ONE LINE: a cold \`apiplan talk\` pays ~565ms for the WS-101 upgrade plus ~330ms of
config round-trips before the first spoken word; the daemon pays both in advance and keeps the
socket parked, which measured 517-555ms to first audio instead of ~1200-1400ms.

OWNERSHIP — do not cross these lines:
- src/talk.ts belongs to ANOTHER agent (Lane A) and is being edited RIGHT NOW. NEVER open it for
  writing. Reading it is fine.
- src/providers.ts and src/platform.ts are shared: DO NOT EDIT either one. If you need a seam
  that does not exist, use \`mock.module()\` from bun:test rather than adding one.
- Only edit the file(s) your own task names.

HOUSE STYLE: TypeScript on Bun, 2-space indent, semicolons. Comments explain WHY and cite the
failure that motivated the line. No new dependencies, ever. Never invent an API you have not
seen in the repo — grep for it.

Report as terse prose: what you did, exact file:line ranges, real command output, and anything you
could NOT verify. Never claim something passes without pasting the run. Your final message IS the
return value.
`

phase('Harden')

const lanes = [
  {
    key: 'offline-park-test',
    prompt: `${SHARED}

YOUR TASK — make the park logic testable WITHOUT touching OpenAI. You create exactly one file:
  ${ROOT}/test/talk-daemon-park.test.ts

Look at ${ROOT}/test/ first and match the existing bun:test conventions exactly.

The seam: bun:test's \`mock.module()\` can replace a module's exports before the module under test
imports it. Use it to stub:
  - "../src/providers.ts"  -> \`openRealtime(token, model)\` returns a FAKE WebSocket-shaped object
    you control, and \`openai\` exposes \`probe()\` -> {connected:true,...} and \`creds()\` ->
    {token:"t", source:"test"}.
  - "../src/talk.ts"       -> \`talk(o)\` resolves after a tick, recording the \`o.socket\`,
    \`o.skipSessionUpdate\` and \`o.manageSignals\` it was handed, and emitting a couple of
    \`o.onEvent("model", "...")\` calls so the NDJSON stream has content.

Your fake socket needs: \`readyState\` (use the real \`WebSocket.OPEN\` = 1 / CONNECTING = 0 numeric
constants), settable \`onopen/onmessage/onerror/onclose\`, a \`send()\` that records frames, and a
\`close()\` that flips readyState and fires onclose. Drive it: after "connect", fire \`onopen\`, then
deliver a \`{"type":"session.created","session":{"expires_at":<unix seconds>}}\` frame and a
\`{"type":"session.updated"}\` frame — that pair is what makes the park report ready.

Then assert, each as its own \`test()\`:
 1. **armPark() parks.** After arming and letting the fake socket complete its handshake,
    \`parkStatus()\` reports \`parked:true\`, \`state:"ready"\`, a non-zero \`connectMs\`, and an
    \`expiresInMs\` in the right ballpark (positive, under ~61 minutes). Also assert the FIRST frame
    the socket received is a \`session.update\` whose session has NO \`instructions\` key — the park
    must stay persona-free, because the persona goes per-call in \`response.instructions\`. This is
    the single most important assertion in the file: a persona baked into the park silently
    poisons every later call.
 2. **The parked socket is handed over, with no second connect.** POST to \`handleTalk()\` with a
    Request whose body is \`{}\` and assert the stubbed \`talk()\` received the SAME socket object the
    park held, with \`skipSessionUpdate === true\` and \`manageSignals === false\`, and that
    \`openRealtime\` was called exactly ONCE overall (the park's connect) — a second call means the
    handover silently failed and the user paid full cold latency.
 3. **NDJSON contract.** Read the streamed response body and assert the lines parse as JSON, that
    the events arrive in order, and that the LAST line is \`{"kind":"end",...}\`.
 4. **Single-caller lock.** A second \`handleTalk()\` while the first is still running returns status
    409 and a body whose JSON has \`error === "busy"\`. Then, after the first completes, a third call
    is accepted again (the lock must release, not latch).
 5. **Re-park after the call.** After the first call finishes, the module arms a new park — assert
    \`openRealtime\` was called a second time and \`parkStatus()\` returns to ready.
 6. **Model mismatch bypasses the park.** With a park held for the default model, a request whose
    \`model\` is something else must NOT consume the park (the model is in the WebSocket URL and
    cannot be changed) — assert a fresh \`openRealtime\` call for that request and that the park
    object is untouched or replaced, whichever the implementation does. State which you observed.

Notes that will save you time:
- \`handleTalk\` returns as soon as the stream starts; the call runs on. Use the returned
  \`Response.body\` reader to await progress rather than a fixed sleep wherever you can.
- If a genuine seam is missing and the test cannot be written honestly, DO NOT weaken the test and
  DO NOT edit talk-daemon.ts — report exactly what is missing and why.
- Deterministic timing only: no \`await Bun.sleep(2000)\` "should be enough" guesses.

Run \`cd ${ROOT} && bun test test/talk-daemon-park.test.ts\` and paste the REAL output, pass or fail.`,
  },
  {
    key: 'adversarial-review',
    prompt: `${SHARED}

YOUR TASK — read-only adversarial review. You edit NOTHING. You produce findings.

Review \`${ROOT}/src/talk-daemon.ts\` in full, plus \`git diff -- src/engine.ts bin/apiplan.ts\`.
Your job is to find the bugs that only appear in production, not the ones a compiler finds.

Hunt specifically for:
1. **Lifecycle races.** armPark() during an in-flight park; a park that completes AFTER a call
   already started; \`busy\` set but a throw before the finally; the re-park in \`queueMicrotask\`
   racing the rotation interval; a park superseded while connecting and its socket leaked.
2. **The single-caller lock.** Is there any path where \`busy\` latches true forever (making the
   daemon permanently refuse voice calls until restarted)? Trace EVERY return and throw.
3. **Socket ownership.** After hand-off, who closes the socket? Trace: normal hangup, CLI Ctrl-C
   (request abort), daemon shutdown, park rotation firing mid-call, and talk() ignoring the
   \`socket\` option entirely (Lane A may not have landed it yet). Is a realtime session ever
   orphaned — still open server-side with nobody holding it? That costs a session slot and looks
   like a mysterious rate limit later.
4. **The listener-leak workaround.** \`runCall\` snapshots \`process.listeners()\` before the call and
   removes anything added after. Is that correct under CONCURRENT calls (there should be none —
   verify the lock actually guarantees it), and does it risk removing a listener some OTHER part
   of the daemon legitimately added during the call window?
5. **Stream correctness.** The ReadableStream controller is captured in \`start()\`. Can \`push()\`
   ever be called after \`close()\` (it is wrapped in try/catch — is swallowing right?), and can the
   response stream stay open forever if \`runCall\` neither resolves nor rejects?
6. **The CLI client.** The NDJSON reader's buffering across chunk boundaries; the overloaded 409
   (version-mismatch vs busy) discrimination; whether the SIGINT handlers it installs are always
   removed; whether \`talkViaDaemon\` returning true-for-busy is the right call (the alternative,
   falling back to direct, would open a SECOND microphone — argue it).
7. **Honest-latency risk.** Anything that would make a parked call SLOWER than cold, or make the
   \`first word in Nms\` number a lie.

For each finding give: severity (critical/major/minor), the exact file:line, the concrete failure
scenario (inputs/timing -> wrong behaviour), and the smallest correct fix. Rank most-severe-first.
Say plainly if you find nothing critical — do not manufacture findings to look thorough.`,
  },
  {
    key: 'doctor-park-row',
    prompt: `${SHARED}

YOUR TASK — surface the park in the diagnostics. You edit ONLY \`${ROOT}/bin/apiplan.ts\`, and only
inside \`cmdDoctor\` (grep for \`rows.push(["daemon"\` — it is around line 176) plus the \`voices\`/
\`status\` neighbours if genuinely needed. Keep the diff under ~25 lines.

Today doctor prints a single daemon row: warm or cold. That is no longer the whole truth — a warm
daemon may or may not be holding a parked realtime socket, and "talk is slow" is now a question
with two different answers.

Add ONE row, \`talk park\`, driven by \`daemonParkStatus()\` exported from \`../src/talk-daemon.ts\`
(import it lazily, inside cmdDoctor, so the plain \`apiplan\` startup path does not pay for it):
  - daemon not reachable            -> warn,  "no daemon (talk connects cold, ~1200ms to first word)"
  - reachable, state "ready"        -> true,  "warm socket parked <N>s · <model> · <voice> · expires in <M>m"
  - reachable, state "connecting"   -> warn,  "parking now"
  - reachable, busy                 -> true,  "on a call"
  - reachable, anything else        -> warn,  "<state> · <last>"   (the status object's \`last\` field
                                              carries the most recent park-lifecycle reason)
Match the EXACT shape of the existing rows (look at how the daemon row builds its tuple, and reuse
the same true/"warn"/false vocabulary and the same helpers — do not invent a new formatting style).

Note the existing daemon row calls \`daemonAlive()\` TWICE in one expression; leave that alone, it is
not your task.

Make sure \`apiplan doctor\` still works with NO daemon running: \`daemonParkStatus()\` returns null in
that case and must not throw or hang.

Verify:
  cd ${ROOT} && bun build bin/apiplan.ts --target=node > /dev/null
  cd ${ROOT} && bun bin/apiplan.ts doctor
Paste the real doctor output.`,
  },
]

const out = await parallel(
  lanes.map((l) => () =>
    agent(l.prompt, { label: l.key, phase: 'Harden', model: 'opus', effort: 'high' })),
)

return lanes.map((l, i) => ({ lane: l.key, result: out[i] }))
