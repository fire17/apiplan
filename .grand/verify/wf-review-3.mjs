export const meta = {
  name: 'apiplan-talk-rev-verify-3-handover',
  description: 'Lane D third pass: the talk.ts <-> talk-daemon.ts warm-socket handover contract, park lifecycle, and the CLI client path',
  phases: [
    { title: 'Find3', detail: 'handover contract · park lifecycle · CLI client path (opus 5)' },
    { title: 'Verify3', detail: 'adversarial refutation (opus 5)' },
  ],
}

const ROOT = '/Users/magic/Creations/APIPlan'

const COMMON = `
Adversarial verification lane on the \`apiplan talk\` Phase-2 daemon. Project root: ${ROOT}.
READ-ONLY on source — write nothing outside ${ROOT}/.grand/verify/.

Read in full before judging anything:
  - ${ROOT}/src/talk-daemon.ts   (BRAND NEW, Lane B — the parked warm socket, /talk route)
  - ${ROOT}/src/talk.ts          (Lane A — the conversation loop the daemon hands a socket to)
  - ${ROOT}/src/engine.ts        (routes /talk and /talk/status into talk-daemon)
  - ${ROOT}/bin/apiplan.ts       (the \`talk\` CLI case)
  - ${ROOT}/bench/talk-latency.sh
  - ${ROOT}/VOICE_UPGRADE_PLAN.md (the oracle, incl. the two REVERSED findings: transcription
    hot-add mid-response ABORTS the call; ffplay pre-spawn on an empty pipe exits 123)
Then \`cd ${ROOT} && git diff\` and \`git status\`.

CRUCIAL CONTEXT — these files are being edited RIGHT NOW by two different lanes, and
talk-daemon.ts passes talk() three options (\`socket\`, \`skipSessionUpdate\`,
\`manageSignals\`) through an \`as any\` cast. Check whether talk.ts actually implements each
one TODAY. If it does not, work out precisely what happens at runtime — do not assume the
cast is harmless just because the comment says it is.

Report ONLY defects with file:line and a concrete runtime trace. Mark confidence low
rather than guessing. Say explicitly when a defect exists only until the other lane lands
its half, and name which lane owns the fix.
`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'scenario', 'fix'],
        properties: {
          title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          scenario: { type: 'string' }, fix: { type: 'string' },
          evidence: { type: 'string' },
          owner: { type: 'string', description: 'which lane owns the fix: A (talk.ts) / B (daemon,engine,bin) / C (skill)' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' }, reasoning: { type: 'string' },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    corrected_fix: { type: 'string' },
  },
}

const LENSES = [
  {
    key: 'handover',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: the warm-socket HANDOVER CONTRACT between talk-daemon.ts and talk.ts.
talk-daemon.ts:340-420 (runCall) may hand talk() an ALREADY-OPEN, already-configured
WebSocket with \`skipSessionUpdate: true\`. talk.ts today was written for a socket IT opens.

Trace, event by event, what happens on the warm path. Two specific hypotheses to confirm
or refute — do not take them on trust, read the code and decide:
  (a) talk.ts:188 does all of its setup inside \`ws.onopen\` — sending session.update AND
      starting micLoop(). A socket handed over already OPEN never fires \`onopen\`. If so,
      what does the call do: does the microphone ever start? Say exactly what the user
      experiences.
  (b) talk.ts:245 fires the greeting only inside \`case "session.updated"\`. With
      \`skipSessionUpdate: true\` no session.update is sent, so no session.updated arrives.
      Combined with the connect watchdog at talk.ts:184-186 (which only clears on the first
      inbound message, talk.ts:239), what is the observed behaviour and after how long?
Then keep going past those two: enumerate EVERY other piece of talk.ts state that assumes
a virgin socket (greeted, connected, firstAudioReported, playingUntil, playerRestarts,
pending, closing, closed, speechStartedAt, lastSpeechMs), and every talk.ts behaviour that
is wrong on a REUSED socket that already carries conversation history from a previous call
(does the model remember the last caller's conversation? that is a privacy question too).
Finally: talk-daemon.ts nulls the park's handlers at 383-387 before handing over — is there
a window where events arriving between nulling and talk() assigning its own handlers are
DROPPED, and what would be lost?

Deliverable: an ordered list of exactly what Lane A must add to talk.ts before the warm
path can work, each with the runtime symptom it prevents.`,
  },
  {
    key: 'park-lifecycle',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: the park's lifecycle and the daemon's liveness. talk-daemon.ts only.
  - The \`busy\` flag (handleTalk ~305): it is set before the call and cleared in
    \`.finally()\`. Enumerate every way \`runCall\` could fail to settle, leaving the daemon
    permanently 409-ing every future call. Is there any timeout, and does cancelTalk()
    actually reach that state? What does the user see, and how do they recover?
  - \`onAbort\` closes \`live\`, but \`live\` is assigned partway through runCall. Is there a
    window where the CLI aborts before \`live\` is set, leaving an orphaned realtime session
    that bills and holds a concurrency slot?
  - armPark / scheduleRepark / startRotation / openParked: retry storms against an endpoint
    the plan says RATE-LIMITS rapid reconnects; backoff and jitter present or absent; the
    60-minute session cap and rotating BEFORE it; whether a rotation can fire mid-call and
    close a socket in use.
  - Park correctness: parkMatches() compares model only, but a park also has voice+barge and
    reconfigure() is called when they differ — is reconfigure's payload safe given the
    REVERSED finding that resending input config mid-response aborts the call? Could a
    reconfigure ever land while a response is in flight?
  - Resource leaks across many calls: rotateTimer / retryTimer / idleEvents (an array that
    is appended to — is it ever bounded?), the credential cache, sockets left open.
  - Does anything here write the bearer token, a transcript, or audio into a log or a trace?`,
  },
  {
    key: 'cli-path',
    effort: 'high',
    prompt: `${COMMON}

YOUR LENS: the CLI client half and the flag contract.
  - talk-daemon.ts:499 tells the user to "use --direct", and bench/talk-latency.sh:123 passes
    \`--direct\` for its cold samples. Grep bin/apiplan.ts: is \`--direct\` actually PARSED
    today? If it is not, say exactly what happens to a user (and to the benchmark) who
    passes it — silently ignored, treated as a greeting string, or an error. Note that
    bin/apiplan.ts:368-370 documents a bare-or-valued flag parser (\`optVal\`) whose quirk is
    that \`--greet --voice cedar\` reads "--voice" as the greeting TEXT; check whether
    \`--direct\` interacts with that.
  - talkViaDaemon (talk-daemon.ts:467+): the NDJSON stream client. Partial-line framing
    across chunk boundaries, a truncated final line, non-200 responses, the 409 busy path,
    the version-mismatch 409 from engine.ts, and what happens when the daemon dies
    mid-stream. Does the user get a clear message or a silent hang?
  - Its signal handlers (talk-daemon.ts:478): does Ctrl-C in the CLI actually end the
    daemon-side call, or only the client? Trace it through req.signal/onAbort.
  - Fallback: if the daemon is absent or refuses, does the CLI transparently fall back to
    the direct path, and is that fallback visible in the latency number bench/ reports?
  - engine.ts's /stop does \`process.exit(0)\` — what happens to a call in progress and to
    its ffmpeg/ffplay children?`,
  },
]

phase('Find3')
const found = await parallel(LENSES.map((l) => () =>
  agent(l.prompt, { label: `find3:${l.key}`, phase: 'Find3', model: 'opus', effort: l.effort, schema: FINDINGS_SCHEMA })
))

const all = found.filter(Boolean).flatMap((r, i) =>
  (r.findings || []).map((f) => ({ ...f, lens: LENSES[i]?.key ?? 'unknown' }))
)
log(`${all.length} raw findings across ${LENSES.length} lenses`)

const rank = { critical: 0, high: 1, medium: 2, low: 3 }
const ordered = [...all].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
const CAP = 8
const toVerify = ordered.slice(0, CAP)
const unverified = ordered.slice(CAP)
if (unverified.length) log(`CAP: ${unverified.length} lower-severity findings reported UNVERIFIED (not dropped)`)

phase('Verify3')
const verified = await parallel(toVerify.map((f) => () =>
  agent(`${COMMON}

You are an adversarial REFUTER. Another reviewer claims:

  title:    ${f.title}
  file:     ${f.file}:${f.line}
  severity: ${f.severity}
  owner:    ${f.owner || '?'}
  scenario: ${f.scenario}
  evidence: ${f.evidence || '(none given)'}
  proposed fix: ${f.fix}

REFUTE it. Open the file at that line and read the whole path. Look hardest for: a guard
the claimant missed, an \`as any\` fallback that makes the failure benign, a Bun/Node
semantic that differs from what they assumed, or a scenario the OpenAI realtime API cannot
actually produce. These files are being edited live — RE-READ them now rather than trusting
the quoted snippet, and if the code has already changed so the claim no longer applies,
refute it and say so.

refuted=true if it is NOT a real defect. Default to refuted=true when genuinely uncertain.
If real but mis-scoped, refuted=false with corrected_severity / corrected_fix.`,
    { label: `verify3:${f.lens}:${f.line}`, phase: 'Verify3', model: 'opus', effort: 'high', schema: VERDICT_SCHEMA })
    .then((v) => ({ ...f, verdict: v }))
))

const survivors = verified.filter(Boolean).filter((f) => f.verdict && !f.verdict.refuted)
const killed = verified.filter(Boolean).filter((f) => f.verdict && f.verdict.refuted)
log(`CONFIRMED ${survivors.length} · refuted ${killed.length} · unverified ${unverified.length}`)

return {
  confirmed: survivors.map((f) => ({
    title: f.title, file: f.file, line: f.line, lens: f.lens, owner: f.owner,
    severity: f.verdict.corrected_severity || f.severity,
    scenario: f.scenario, evidence: f.evidence,
    fix: f.verdict.corrected_fix || f.fix,
    refuter_note: f.verdict.reasoning,
  })),
  refuted: killed.map((f) => ({ title: f.title, file: f.file, line: f.line, why: f.verdict.reasoning })),
  unverified: unverified.map((f) => ({ title: f.title, file: f.file, line: f.line, severity: f.severity, owner: f.owner, scenario: f.scenario, fix: f.fix })),
}
