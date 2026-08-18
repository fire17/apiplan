export const meta = {
  name: 'apiplan-talk-rev-verify-2',
  description: 'Lane D second pass: Phase-2 daemon readiness, Phase-3 tool-call safety, and a simplify/altitude lens — each finding refuted before it survives',
  phases: [
    { title: 'Find2', detail: 'daemon readiness · tool-call safety · simplify (opus 5)' },
    { title: 'Verify2', detail: 'adversarial refutation (opus 5)' },
  ],
}

const ROOT = '/Users/magic/Creations/APIPlan'

const COMMON = `
You are a lane in an adversarial VERIFICATION fleet reviewing the \`apiplan talk\` voice
upgrade. Project root: ${ROOT}. READ-ONLY on source — never edit anything outside
${ROOT}/.grand/verify/. Read first, in full:
  - ${ROOT}/VOICE_UPGRADE_PLAN.md  (the oracle: measured findings, Phase 0/1/2/3 plan, and
    the REVERSED findings — transcription hot-add mid-response ABORTS the call; ffplay
    pre-spawn on an empty pipe exits 123 because of -autoexit.)
  - ${ROOT}/src/talk.ts · ${ROOT}/src/engine.ts · ${ROOT}/src/providers.ts
  - ${ROOT}/src/platform.ts · ${ROOT}/src/commands.ts · ${ROOT}/bin/apiplan.ts
Run \`cd ${ROOT} && git diff\` for the uncommitted change under review.
Report ONLY defects with file:line and a concrete failure scenario. No style nits, no
praise. Mark confidence low rather than guessing.
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
    key: 'daemon-readiness',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: is talk.ts SAFE to run inside the Phase-2 daemon, more than once per process?
Today \`apiplan talk\` is one call per process. Phase 2 makes engine.ts's runDaemon park a
warm realtime socket and serve many calls from ONE long-lived process. Enumerate every
piece of talk.ts that is process-global or one-shot and would therefore break, leak, or
mis-fire on the SECOND call in the same process. Be exhaustive and concrete:
  - process.on(SIGINT/SIGTERM/SIGHUP/exit/uncaughtException) registered per talk() call —
    count how many accumulate over N calls, what Node/Bun does at the default max-listeners
    threshold, and what a stale handler's close() actually touches. Is the uncaughtException
    handler (which re-throws) safe to install in a server process at all?
  - module-scope vs closure state; anything read from process.env at call time (LX_T0_MS is
    per-process but latency must become per-CALL in a daemon — what breaks?).
  - The single-caller lock the plan requires: what concretely goes wrong if two /call
    requests overlap on one parked socket?
  - Re-parking after a call, and the 60-minute session cap / expires_at rollover: what
    state in talk.ts assumes a fresh socket and would be wrong on a reused one (greeted,
    firstAudioReported, playingUntil, playerRestarts, pending, closing, closed)?
  - engine.ts's existing IPC (unix socket 0600, /health /stop /call): does anything there
    already conflict with holding a WS open — idleTimeout: 240, process.exit(0) on /stop
    orphaning ffmpeg/ffplay, unlink-on-start racing a live daemon?
Give Lane B a precise, ordered list of what must change in talk.ts BEFORE the daemon can
host it. Severity by how silently it fails.`,
  },
  {
    key: 'toolcall-safety',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: Phase-3 tool-calls and the live-monitor, reviewed BEFORE they are written.
The plan says: session gets \`tools\` + \`tool_choice\`; a \`function_call\` item is handled
by an ALLOW-LISTED \`onTool\`; the result goes back as \`function_call_output\` then
\`response.create\`. The first shipped tool is \`/lx\` (live-explain), launched backgrounded,
with the agent tailing the Phase-0 sidecar.

Do two things:
1. Read ${ROOT}/src/commands.ts and engine.ts and determine whether ANY existing surface
   would let a model-emitted tool call reach a shell, a filesystem write, or a network
   call today — quote the code path if so. Check ~/.apiplan/commands.json: who writes it,
   is it executed, and could a realtime model influence its contents?
2. Specify the allow-list contract that Phase 3 must satisfy, as testable rules: exact
   name matching (not prefix/regex), argument SCHEMA validation before dispatch, no
   pass-through of model-authored strings into argv or a shell, a per-call timeout, a
   concurrency cap, and what must be REFUSED outright. Say what a malicious or merely
   confused model could otherwise do — including via the persona file (--as-file), the
   --log path, and the /lx launch.
Also: the live-monitor tails a file the model's own words land in. Does that create a
loop or an injection path where transcribed speech becomes agent instructions? Say plainly
whether prompt-injection-via-voice is reachable and what blocks it.`,
  },
  {
    key: 'simplify',
    effort: 'high',
    prompt: `${COMMON}

YOUR LENS: simplification, reuse, and altitude — QUALITY ONLY, not bug-hunting.
The house style here is "polish, do not accrete": fewer, more meaningful lines beat many.
talk.ts grew ~190 lines in this diff. Find, with file:line:
  - Duplicated logic that should be one helper (openRealtime already deduped talk.ts and
    providers.ts — is there more of that? compare the two WS event switches).
  - State that could be derived instead of tracked (speaking vs playingUntil vs
    stillAudible vs player!=null — are all four needed, or is one enough?).
  - Supervisors/counters that could collapse into one bounded-restart helper shared by the
    mic and the player, instead of two hand-rolled backoff loops.
  - Anything the OpenAI API already does for us that the code re-implements.
  - Dead or now-unreachable code left behind by the two REVERSED findings (hot-add and
    pre-spawn) — leftover comments, flags, or branches that no longer apply.
Report each as a finding whose "fix" is the smaller version. Severity here means "how much
complexity does removing it buy" — use medium/low; reserve high for something that will
actively mislead the next maintainer.`,
  },
]

phase('Find2')
const found = await parallel(LENSES.map((l) => () =>
  agent(l.prompt, { label: `find2:${l.key}`, phase: 'Find2', model: 'opus', effort: l.effort, schema: FINDINGS_SCHEMA })
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

phase('Verify2')
const verified = await parallel(toVerify.map((f) => () =>
  agent(`${COMMON}

You are an adversarial REFUTER. Another reviewer claims:

  title:    ${f.title}
  file:     ${f.file}:${f.line}
  severity: ${f.severity}
  scenario: ${f.scenario}
  evidence: ${f.evidence || '(none given)'}
  proposed fix: ${f.fix}

REFUTE it. Open the file at that line, read the whole control path, and try to show the
claim is wrong — mis-read code, a guard missed, an impossible precondition, an inflated
severity, or (for simplify findings) a simplification that would actually break something.
Where it turns on OpenAI realtime API behaviour or on Bun/Node semantics, WebSearch the
current docs rather than trusting memory.

refuted=true if it is NOT a real defect. Default to refuted=true when genuinely uncertain —
findings must EARN survival. If real but mis-scoped, refuted=false plus corrected_severity
and corrected_fix.`,
    { label: `verify2:${f.lens}:${f.line}`, phase: 'Verify2', model: 'opus', effort: 'high', schema: VERDICT_SCHEMA })
    .then((v) => ({ ...f, verdict: v }))
))

const survivors = verified.filter(Boolean).filter((f) => f.verdict && !f.verdict.refuted)
const killed = verified.filter(Boolean).filter((f) => f.verdict && f.verdict.refuted)
log(`CONFIRMED ${survivors.length} · refuted ${killed.length} · unverified ${unverified.length}`)

return {
  confirmed: survivors.map((f) => ({
    title: f.title, file: f.file, line: f.line, lens: f.lens,
    severity: f.verdict.corrected_severity || f.severity,
    scenario: f.scenario, evidence: f.evidence,
    fix: f.verdict.corrected_fix || f.fix,
    refuter_note: f.verdict.reasoning,
  })),
  refuted: killed.map((f) => ({ title: f.title, file: f.file, line: f.line, why: f.verdict.reasoning })),
  unverified: unverified.map((f) => ({ title: f.title, file: f.file, line: f.line, severity: f.severity, scenario: f.scenario, fix: f.fix })),
}
