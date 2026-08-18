export const meta = {
  name: 'rev-daemon-p1',
  description: 'APIPlan warm-talk-daemon: engine wiring, bench harness, adversarial realtime-API review',
  phases: [
    { title: 'Build', detail: 'engine.ts route wiring + bench harness + realtime API fact-check, in parallel' },
    { title: 'Verify', detail: 'compile + adversarial review of the landed diff' },
  ],
}

const ROOT = '/Users/magic/Creations/APIPlan'

const SHARED = `
You are a lane inside the APIPlan "warm talk daemon" build (project root ${ROOT}).

BACKGROUND (all measured live, from ${ROOT}/VOICE_UPGRADE_PLAN.md — read it):
- \`apiplan talk\` opens a fresh realtime WebSocket to wss://api.openai.com/v1/realtime on every
  call. Cold first-audio is ~1200-1400ms; ~60% of that is the WS-101 upgrade (server-side session
  alloc, ~565ms) plus two config round-trips (~330ms). TLS is ~15ms — irrelevant.
- The fix: the existing warm daemon (src/engine.ts \`runDaemon\`, unix socket at ~/.apiplan/daemon.sock,
  routes /health //stop //call, served by \`Bun.serve({ unix, idleTimeout, fetch })\`) holds a
  PRE-OPENED, PRE-\`session.update\`d realtime socket parked and ready. Handing that parked socket to
  the conversation core gives measured first-audio of 517-555ms.

WHO OWNS WHAT (do not cross these lines):
- src/talk.ts is owned by ANOTHER agent (Lane A). NEVER edit it. Import from it only.
- src/talk-daemon.ts is being written RIGHT NOW by the lane lead, in parallel with you.
  Do not create or edit it. Build against its documented API below; assume it exists.
- Everything else: only touch the file your task names.

THE src/talk-daemon.ts PUBLIC API (already decided — code against it verbatim):
\`\`\`ts
export type TalkReq = {
  voice?: string; model?: string; direction?: string;
  greet?: boolean | string; barge?: boolean; hangup?: string[]; logFile?: string;
};
/** Handle POST /talk. Streams newline-delimited JSON:
 *  {"kind":"you"|"model"|"info","text":"..."} per line, then {"kind":"end","reason":"..."}.
 *  Returns 409 with {"error":"busy"} when a call is already in progress. */
export function handleTalk(req: Request): Promise<Response>;
/** GET /talk/status -> JSON park diagnostics. */
export function parkStatus(): Record<string, unknown>;
/** Arm the park (idempotent, non-blocking, safe to call when OpenAI is not logged in). */
export function armPark(reason?: string): void;
/** Close the parked socket + stop rotation (daemon shutdown). */
export function shutdownPark(): void;
/** CLI side: run a talk call through the daemon. Returns false when there is no daemon
 *  (caller should fall back to direct talk()); true when the call ran to completion. */
export function talkViaDaemon(
  r: TalkReq,
  render: (kind: 'you' | 'model' | 'info', text: string) => void,
): Promise<boolean>;
\`\`\`

HOUSE STYLE (this codebase is unusually well commented — match it):
- Comments explain WHY, and cite the failure that motivated the line ("a leftover ffmpeg keeps the
  mic device open and the next run fails with device busy"). No comment restates the code.
- TypeScript, Bun runtime, 2-space indent, no semicolon-free style (semicolons ARE used).
- Prefer small pure helpers over classes. No new dependencies, ever.
- Never invent an API you have not seen in the repo. If you need a fact, grep for it.

Report back as terse prose: what you changed, the exact line ranges, and anything you could NOT
verify. Do not claim something works if you did not run it. Your final message IS the return value.
`

phase('Build')

const lanes = [
  {
    key: 'engine-wiring',
    prompt: `${SHARED}

YOUR TASK — wire the daemon routes into ${ROOT}/src/engine.ts. This is the ONLY file you edit.

Read src/engine.ts fully first (615 lines; the daemon section starts at the "warm daemon" banner
comment, around line 407, and \`runDaemon\` is around line 437).

Make exactly these changes:

1. Add a lazy import of the talk-daemon module INSIDE runDaemon's handler paths — NOT a top-level
   \`import\` — because src/talk-daemon.ts will (lazily) reach for providers/creds and engine.ts is
   also the hot path for plain text calls, which must stay cold-start-cheap. Use
   \`const TD = await import("./talk-daemon.ts");\` at the point of use, or hoist a memoised
   \`let td: typeof import("./talk-daemon.ts") | null = null;\` helper near runDaemon. Explain the
   choice in a comment.

2. In the \`handler\` inside runDaemon, add two routes, placed after the existing /stop route and
   before /call:
   - \`POST /talk\`  -> \`return (await talkDaemon()).handleTalk(req);\`
     Keep the same x-apiplan-version 409 mismatch guard that /call uses — a thin CLI from another
     build must not be served by this daemon.
   - \`GET /talk/status\` -> \`return Response.json((await talkDaemon()).parkStatus());\`
     (Bun supports Response.json; if you would rather not rely on it, build the Response by hand
     with content-type application/json. Grep the repo for existing usage and match it.)
   Both routes must also update \`lastReq\` — they already will, since lastReq is set at the top of
   the handler; confirm that and say so.

3. Extend the existing \`warm()\` closure so it also warms api.openai.com when the openai provider
   is connected. Today warm() loops PROVIDERS and hits api.anthropic.com/v1/models (GET) or
   chatgpt.com (HEAD). The openai/codex provider's warm host must ALSO include
   \`https://api.openai.com/\` with method HEAD — that is the host the realtime WebSocket resolves
   and handshakes against, and warming it is the cheap fallback speedup for the case where the
   park is cold. Do NOT send credentials on this probe; an unauthenticated HEAD is enough to
   establish the TLS/DNS path. Comment WHY (cite: TLS is only ~15ms of the 1200ms, so this is a
   small fallback win, not the main event — the park is).

4. At the end of runDaemon's startup (right after the "apiplan daemon listening on ..." stderr
   line), arm the park when asked:
   \`\`\`ts
   // Parking holds an OpenAI realtime session open, so it is opt-in at boot: most daemon
   // lifetimes serve only text calls and should not hold a voice session. The first
   // \`apiplan talk\` arms it, and it re-parks after every call (see talk-daemon.ts).
   if (/^(1|on|true|yes)$/i.test(process.env.APIPLAN_TALK_PARK ?? "")) {
     import("./talk-daemon.ts").then((td) => td.armPark("daemon boot")).catch(() => {});
   }
   \`\`\`

5. In the \`bye\` handler inside runDaemon (the SIGINT/SIGTERM cleanup that unlinks the socket),
   call \`shutdownPark()\` first so the parked realtime socket is closed politely instead of being
   dropped. It must be non-blocking and must never prevent exit — wrap in try/catch and, since the
   module may never have been loaded, only call it if the memoised module handle is non-null.
   Do NOT make bye() async.

CONSTRAINTS:
- Do not change VERSION.
- Do not touch anything outside runDaemon and the warm() closure.
- Do not reformat surrounding code; keep the diff tight and reviewable.
- After editing, run: \`cd ${ROOT} && bun build src/engine.ts --target=node > /dev/null\` and report
  the result verbatim. It will FAIL with "Could not resolve ./talk-daemon.ts" if the lead has not
  landed that file yet — that specific failure is EXPECTED and fine; report it as such. Any OTHER
  error is yours to fix.`,
  },
  {
    key: 'bench-harness',
    prompt: `${SHARED}

YOUR TASK — build the measurement + protocol-test harness. You create ONLY these files:
  ${ROOT}/bench/talk-latency.sh          (measures cold vs parked first-audio)
  ${ROOT}/bench/talk-protocol.test.ts    (offline test of the NDJSON stream contract)

Look at ${ROOT}/bench/ first to match the conventions already there.

A) bench/talk-latency.sh — an honest A/B of first-audio latency.
   The existing instrumentation: src/talk.ts reports \`first word in <N>ms\` as an "info" event,
   measured from the env var \`LX_T0_MS\` (a millisecond epoch the LAUNCHER sets). So the harness is:
     - set LX_T0_MS to the epoch ms right before launching
     - launch \`apiplan talk --greet "<one short fixed sentence>" ...\` (or \`bun bin/apiplan.ts talk\`)
     - capture stdout, grep out \`first word in ([0-9]+)ms\`, print it
   Requirements:
     - Two modes: \`cold\` (force the direct path with the --direct flag) and \`warm\` (daemon path).
     - N repetitions (default 5), print every sample plus min/median/mean, and the delta between
       the two modes. Use plain awk/sort for the stats — no python, no jq dependency.
     - Between samples, sleep at least 3s: the realtime endpoint rate-limits rapid reconnects and a
       throttled connect poisons the measurement. Say so in a comment.
     - Cleanup between samples must be SURGICAL. NEVER \`pkill ffmpeg\` — that kills unrelated
       projects on this machine. Only \`pkill -x ffplay\` and \`pkill -f avfoundation\`. This is a hard
       rule; put it in a comment so nobody "fixes" it later.
     - It must degrade honestly: if no \`first word in\` line appears, print
       \`sample N: NO AUDIO (see log)\` rather than silently recording a zero.
     - Set \`APIPLAN_TALK_LOG\` to a per-sample path under /tmp so a failed sample is diagnosable.
     - \`set -euo pipefail\`, a \`--help\`, and executable bit (chmod +x).

B) bench/talk-protocol.test.ts — proves the daemon<->CLI wire format without touching OpenAI.
   Use \`bun:test\` (grep ${ROOT}/test/ for the existing style and MATCH it).
   Stand up a throwaway \`Bun.serve({ unix: "/tmp/apiplan-proto-<pid>.sock", fetch })\` that replays a
   canned NDJSON stream:
     {"kind":"info","text":"listening"}
     {"kind":"you","text":"hello"}
     {"kind":"model","text":"hi there"}
     {"kind":"end","reason":"closed"}
   ...emitted with a small delay between lines, and assert that a reader which splits on newline
   and JSON.parses each line receives them IN ORDER, INCREMENTALLY (not all at once at the end),
   and that a line split ACROSS two chunk boundaries is reassembled correctly. That last case is
   the real bug this test exists to catch: a naive \`chunk.split("\\n")\` reader corrupts any JSON
   object that straddles a TCP/pipe boundary, and it only shows up under load. Deliberately emit
   one object in two halves to prove it.
   Also assert the 409-busy shape: a second concurrent request gets status 409 and a body whose
   JSON has \`error === "busy"\`.
   Do NOT import src/talk-daemon.ts — this test must run standalone and green today. It pins the
   CONTRACT, not the implementation.
   Run it: \`cd ${ROOT} && bun test bench/talk-protocol.test.ts\` and report the real output.`,
  },
  {
    key: 'api-factcheck',
    prompt: `${SHARED}

YOUR TASK — read-only adversarial fact-check. You edit NOTHING. You produce findings.

The parked-socket design rests on assumptions about the OpenAI GA realtime API. Some are load-
bearing; a wrong one costs a whole live-debug cycle. Establish, for each, whether the repo already
proves it, contradicts it, or is silent — and say WHICH, with file:line evidence. Where the repo is
silent, say "UNVERIFIED — no evidence in repo" rather than guessing from memory.

Sources to mine (all inside ${ROOT}): DARWIN.md (31k, the empirical log), CONTINUE.md,
VOICE_UPGRADE_PLAN.md, README.md, src/providers.ts (openRealtime / speakRealtime),
src/talk.ts, src/dictation.ts, and anything under test/ or examples/. Also check
\`git log --oneline -40\` and \`git log -p --  src/talk.ts | head -400\` for reverted experiments —
a reverted commit is the cheapest possible evidence that something did NOT work.

THE CLAIMS:
1. \`session.update\` MERGES with the existing session rather than replacing it wholesale — i.e. is it
   safe to later send a partial \`{ session: { audio: { output: { voice } } } }\` to change only the
   voice, or does that wipe \`audio.input\` (transcription / turn_detection / noise_reduction)?
   This decides whether the park can be voice-agnostic or must re-send its FULL config when the
   caller asks for a non-default voice. Note: VOICE_UPGRADE_PLAN.md STATUS records that resending
   \`turn_detection\` MID-RESPONSE makes the server abort the call. Is there evidence about doing it
   BEFORE any response, on an idle socket?
2. Where does the session expiry live? The design rotates the parked socket before a measured
   ~60-minute cap by reading \`expires_at\`. Which event carries it (\`session.created\`?
   \`session.updated\`?), and is it unix SECONDS or milliseconds? Any evidence in repo?
3. Can \`response.create\` carry a per-response \`voice\` (e.g. \`response: { audio: { output: { voice } } }\`)?
   If yes, the park never needs re-configuring for voice at all — that is strictly better.
4. Does the server send anything unprompted on an IDLE configured socket (keepalive pings, or an
   \`idle_timeout_ms\`-driven event)? \`talk.ts\` sets \`turn_detection.idle_timeout_ms = 15000\`. If the
   server fires an idle event 15s after the park with no audio flowing, the park could be killed
   before it is ever used — that is a design-breaking risk. Assess it and say how it should be
   handled (e.g. park WITHOUT idle_timeout_ms and add it at call time, which costs a round trip —
   versus park WITH it and accept the risk).
5. Is the model name part of the URL (\`?model=\`) and therefore fixed at park time? Confirm from
   src/providers.ts. If so, a caller asking for a different \`--model\` cannot use the park — the
   daemon must detect the mismatch and connect cold for that call. Confirm and state it plainly.

Then, adversarially: name the THREE most likely ways this whole parked-socket design fails in
production that are NOT on the list above. Be concrete and mechanism-level (not "it might be
flaky"). For each, give the cheapest detection and the cheapest mitigation.

Return a compact findings report: one numbered section per claim with VERDICT (PROVEN / CONTRADICTED /
UNVERIFIED) + evidence + the design consequence, then the three failure modes.`,
  },
]

const built = await parallel(
  lanes.map((l) => () =>
    agent(l.prompt, { label: l.key, phase: 'Build', model: 'opus', effort: 'high' })),
)

phase('Verify')

const report = built.filter(Boolean).map((r, i) => `### ${lanes[i]?.key}\n${r}`).join('\n\n')

const verdicts = await parallel([
  () => agent(`${SHARED}

YOUR TASK — compile gate + tight adversarial review of what just landed. You may FIX small breakages
in ${ROOT}/src/engine.ts, ${ROOT}/bench/talk-latency.sh and ${ROOT}/bench/talk-protocol.test.ts ONLY.
NEVER touch src/talk.ts or src/talk-daemon.ts — report problems in those instead of editing them.

Run, and report each result verbatim:
  cd ${ROOT} && bun build src/engine.ts --target=node > /dev/null
  cd ${ROOT} && bun build bin/apiplan.ts --target=node > /dev/null
  cd ${ROOT} && bun test bench/talk-protocol.test.ts
  cd ${ROOT} && bash -n bench/talk-latency.sh
A failure of the form "Could not resolve ./talk-daemon.ts" is EXPECTED if the lead has not landed
that file yet — report it, do not paper over it by stubbing the file.

Then review \`git diff -- src/engine.ts bench/\` for: routes unreachable because of guard ordering,
the version-mismatch guard accidentally applied to /health, lastReq not updated, a blocking call in
bye(), an accidental credential leak onto the unauthenticated warm probe, and any \`pkill ffmpeg\`
(a hard violation — only \`pkill -x ffplay\` and \`pkill -f avfoundation\` are allowed).

Report: PASS/FAIL per command, then findings most-severe-first, then what you fixed.

For context, the build lanes reported:\n${report}`,
    { label: 'compile-review', phase: 'Verify', model: 'opus', effort: 'xhigh' }),
])

return { built: built.map((b, i) => ({ lane: lanes[i]?.key, ok: !!b })), verdicts }
