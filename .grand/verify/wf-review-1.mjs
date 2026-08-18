export const meta = {
  name: 'apiplan-talk-rev-verify-1',
  description: 'Lane D adversarial review of apiplan talk: realtime-API conformance, correctness, security — each finding refuted before it survives',
  phases: [
    { title: 'Find', detail: 'API conformance · correctness · security, three independent lenses (opus 5)' },
    { title: 'Verify', detail: 'adversarial refutation of every high/critical finding (opus 5)' },
  ],
}

const ROOT = '/Users/magic/Creations/APIPlan'

const COMMON = `
You are a lane in an adversarial VERIFICATION fleet reviewing the \`apiplan talk\` voice
upgrade. Project root: ${ROOT}. You are READ-ONLY on source — never edit src/, bin/, or
any file outside ${ROOT}/.grand/verify/. Read these first, in full:
  - ${ROOT}/VOICE_UPGRADE_PLAN.md   (the oracle: three research lanes' measured findings,
    Phase 0/1 status, and — critically — the REVERSED findings that were built then removed
    after live testing: (a) transcription hot-add mid-response ABORTS the call, so
    transcription must stay at connect time; (b) ffplay pre-spawn on an empty pipe exits
    with code 123 because of -autoexit, so the player must spawn lazily.)
  - ${ROOT}/src/talk.ts        (the conversation loop — Lane A owns it)
  - ${ROOT}/src/providers.ts   (openRealtime + speakRealtime)
  - ${ROOT}/src/platform.ts    (micCommand / speakerCommand)
  - ${ROOT}/src/engine.ts      (the daemon: runDaemon, unix socket, /health /stop /call)
  - ${ROOT}/bin/apiplan.ts     (the \`talk\` CLI case, around line 470)
Also run \`cd ${ROOT} && git diff\` to see the uncommitted working tree — that is the
change under review.

Report ONLY defects you can point at with file:line and a concrete failure scenario
(inputs/state -> wrong behaviour). No style nits, no praise, no speculation dressed as
fact. If you are unsure whether something is real, say so and mark confidence low.
`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'line', 'severity', 'scenario', 'fix'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          scenario: { type: 'string', description: 'concrete inputs/state -> wrong behaviour' },
          fix: { type: 'string', description: 'the smallest correct change' },
          evidence: { type: 'string', description: 'quoted code and/or the doc/plan line that proves it' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean', description: 'true if the finding is NOT a real defect' },
    reasoning: { type: 'string' },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    corrected_fix: { type: 'string' },
  },
}

const LENSES = [
  {
    key: 'api-conformance',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: conformance with the CURRENT OpenAI Realtime API over WebSocket.
Use WebSearch and WebFetch against platform.openai.com's realtime docs (the GA
\`session.update\` shape, the \`gpt-realtime\` model, server events) — do NOT answer from
memory; the API changed shape (beta \`modalities\`/\`input_audio_format\` -> GA
\`output_modalities\`/\`audio.input.format\`), so cite the doc text you actually fetched.

Check EVERY field talk.ts sends and every event name it switches on:
  - the \`session.update\` payload: session.type, output_modalities, instructions,
    audio.input.format {type,rate}, audio.input.transcription.model,
    audio.input.noise_reduction.type, audio.input.turn_detection
    {type, threshold, prefix_padding_ms, silence_duration_ms, idle_timeout_ms},
    audio.output.voice, audio.output.format.
  - \`response.create\` with \`response.instructions\`.
  - \`input_audio_buffer.append\` base64 framing.
  - Every server event it handles AND every one it should handle but does not:
    session.created/updated, input_audio_buffer.speech_started/stopped/committed,
    conversation.item.input_audio_transcription.completed/failed/delta,
    response.created, response.output_audio.delta, response.output_audio_transcript.done,
    response.done (including response.status == 'failed'/'incomplete' inside it),
    rate_limits.updated, error.
Flag: fields that do not exist / are misplaced / are named per the old beta shape; events
handled under a wrong name; and any handled-but-never-emitted alias. Also state which of
the code's dual aliases (response.audio.delta vs response.output_audio.delta) the current
API actually emits, with the doc line.`,
  },
  {
    key: 'correctness',
    effort: 'xhigh',
    prompt: `${COMMON}

YOUR LENS: correctness, concurrency, and the reversed-finding traps.
Hunt specifically for:
  - Any place the removed ffplay PRE-SPAWN pattern still survives — i.e. a player spawned
    when there is no audio byte to write yet. \`-autoexit\` on an empty stdin exits 123.
    Trace the barge-in path (input_audio_buffer.speech_started) and the restart supervisor
    carefully; state exactly what happens after such a spawn, including whether the
    bounded restart counter turns it into a death-loop and what the user sees/hears.
  - Any place turn_detection or the input config is re-sent mid-response (the abort trap).
  - Lifecycle: process-level listeners (SIGINT/SIGTERM/SIGHUP/exit/uncaughtException)
    registered per talk() call — what happens when talk() runs more than once in one
    process, which is exactly what the Phase-2 daemon (engine.ts runDaemon) will do.
  - Timers and state that are never reset across turns (playerRestarts, replyTimer,
    playingUntil, speechStartedAt, lastSpeechMs, pending[]).
  - The mic supervisor: what happens on a machine where ffmpeg CAN be found but the
    avfoundation device cannot be opened (this is real — it reproduces here). Walk the
    backoff arithmetic and say precisely how long a --greet-only call survives and what
    ends it. Is ending the whole call correct for a greet-only / speaker-only use?
  - Races between endPlayer() setting player=null and the p.exited handler.
  - The hangup path: can a reply be lost, or the call be left open, or the goodbye be cut?
  - The connect watchdog and ws.onclose/onerror interaction — double-resolve, leaked timer.
  - The first-word latency stamp: is it stamped at the right moment now that pre-spawn is
    gone, and does the reported number match what a listener actually hears?`,
  },
  {
    key: 'security',
    effort: 'high',
    prompt: `${COMMON}

YOUR LENS: security and privacy.
  - Secrets: can the bearer token, an API key, or a keychain value reach the sidecar JSONL
    log, stdout, an error message, or a crash trace? Trace \`rec()\`, \`say()\`, the
    \`error\` event branch (does the provider's error message ever embed a key fragment?),
    and the uncaughtException handler.
  - Audio/PII: the sidecar contains verbatim transcripts of a private conversation. What
    permissions is the file created with, where does it default to, and is the path
    attacker-influenceable (APIPLAN_TALK_LOG, --log) — symlink/traversal/overwrite?
  - Command execution: every Bun.spawn / spawnSync in talk.ts, platform.ts, providers.ts,
    engine.ts — is any argument attacker- or model-influenceable (voice, model, persona
    file, --log path)? Argument-injection into ffmpeg/ffplay flags counts.
  - The Phase-3 tool-call plan says tools must be ALLOW-LISTED with no arbitrary exec.
    Read engine.ts / commands.ts and say whether any existing surface would let a model's
    function_call reach a shell today, and what the allow-list must look like.
  - The daemon unix socket (~/.apiplan/daemon.sock): permissions, peer auth, and whether
    any local user/process could drive a call or read a transcript through it.`,
  },
]

phase('Find')
const found = await parallel(LENSES.map((l) => () =>
  agent(l.prompt, { label: `find:${l.key}`, phase: 'Find', model: 'opus', effort: l.effort, schema: FINDINGS_SCHEMA })
))

const all = found.filter(Boolean).flatMap((r, i) =>
  (r.findings || []).map((f) => ({ ...f, lens: LENSES[i]?.key ?? 'unknown' }))
)
log(`${all.length} raw findings across ${LENSES.length} lenses`)

// Verify only what matters: critical/high first, then medium, capped so the fleet stays
// inside the size guideline. Anything not verified is reported as UNVERIFIED, never as
// silently dropped.
const rank = { critical: 0, high: 1, medium: 2, low: 3 }
const ordered = [...all].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
const CAP = 8
const toVerify = ordered.slice(0, CAP)
const unverified = ordered.slice(CAP)
if (unverified.length) log(`CAP: ${unverified.length} lower-severity findings reported UNVERIFIED (not dropped)`)

phase('Verify')
const verified = await parallel(toVerify.map((f) => () =>
  agent(`${COMMON}

You are an adversarial REFUTER. Another reviewer claims this defect:

  title:    ${f.title}
  file:     ${f.file}:${f.line}
  severity: ${f.severity}
  scenario: ${f.scenario}
  evidence: ${f.evidence || '(none given)'}
  proposed fix: ${f.fix}

Your job is to REFUTE it. Open the file at that line, read the surrounding code and the
whole control path, and try hard to show the claim is wrong — mis-read code, a guard the
claimant missed, an impossible precondition, a scenario the API cannot produce, or a
severity that is inflated. Where the claim depends on the OpenAI realtime API's behaviour,
WebSearch/WebFetch the current docs rather than trusting memory.

Set refuted=true if it is NOT a real defect. Default to refuted=true when you are
genuinely uncertain — a finding must EARN survival. If it is real but the severity or the
proposed fix is wrong, set refuted=false and give corrected_severity / corrected_fix.`,
    { label: `verify:${f.lens}:${f.file.split('/').pop()}:${f.line}`, phase: 'Verify', model: 'opus', effort: 'high', schema: VERDICT_SCHEMA })
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
