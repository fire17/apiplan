# apiplan `talk` upgrade — speed · reliability · tools · live-monitor

Synthesis of three measured research lanes (2026-08-17). Every number below was reproduced
live against `wss://api.openai.com/v1/realtime`, not estimated.

## Measured latency truth (cold, first word)
Local work is **~65ms — not the problem.** ~60% is the WS-101 upgrade (OpenAI server-side
session alloc, ~565ms) + two config round-trips (~330ms). **TLS is ~15ms (1%) — do not
touch it.** Metric bug: `first word in Nms` stamps at first *delta*, before ffplay/CoreAudio
open → true audible is 75–170ms higher than reported.

## The one big win (two lanes converged)
A **warm daemon holding a pre-connected, pre-configured realtime socket** → parked-socket
first audio **517–555ms** (measured). Daemon machinery already exists (`engine.ts runDaemon`,
unix socket, `/health`/`/stop`/`/call`) — it just never warms `api.openai.com`.

## Do-NOT (measured dead ends)
TLS tuning · cert pinning · `NODE_TLS_REJECT_UNAUTHORIZED=0` · pipelining
`session.update`+`response.create` (no win) · `bun --compile` (no win) · g711 (no win) ·
`reasoning.effort:low` (unsupported on gpt-realtime) · `gpt-realtime-2.1`/`mini` (+300ms).
Keepalive/idle-disconnect does NOT reproduce vs api.openai.com directly (Azure/proxy myth) —
ping is defense, not an active bug.

## Build phases

### Phase 0 — substrate (unblocks + verifies all)
- [ ] `openRealtime()` shared helper — dedupe `talk.ts:39` & `providers.ts:115`.
- [ ] Sidecar JSONL event log (`logFile` opt / `APIPLAN_TALK_LOG`), flush per line, never log
      token/audio. **Doubles as the live-monitor transport.**
- [ ] Fix audible-latency metric (stamp at player-ready, done with pre-spawn in P1).

### Phase 1 — cheap wins + kill silent bugs (no daemon → ~1450ms, bulletproof)
- [ ] Drop whisper from connect-time; hot-add after first delta (−90ms, live-verified).
- [ ] Pre-spawn ffplay + `-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0` (−75–170ms real).
- [ ] Trim session `instructions`; facts only in greeting `response.instructions`.
- [ ] Mic-death supervisor (respawn+backoff) — R1 silent black hole.
- [ ] Per-turn ffplay-death supervisor — R6 silent black hole.
- [ ] Orphan cleanup on SIGINT/SIGTERM/SIGHUP/exit/uncaught (idempotent `close()`) — R5.
- [ ] Whisper hangup-guard: noise must not fire the irreversible "bye" — R10c.
- [ ] One-liners: `noise_reduction` far/near_field · `idle_timeout_ms` · backpressure
      (`bufferedAmount`) · `pendingReply` → array + `.failed` handler.

### Phase 2 — the big speed win + robust transport (med risk)
- [ ] Daemon parks a warm socket; owns ffmpeg/ffplay; CLI is a thin SSE text client. Persona
      via `response.instructions` (not session config) so the park stays generic. Single-caller
      lock; re-park after each call; rotate before 60-min cap. → ~600ms audible.
- [ ] Cached local opener (`~/.apiplan/openers/<voice>.pcm`) played instantly → perceived ~150ms.
- [ ] Auto-reconnect (250ms→8s backoff+jitter, ~6 tries) — R2.
- [ ] `expires_at` pre-emptive rollover at −180s between turns — R4.
- [ ] ping/pong watchdog (defense) — R3. `talk()` returns a typed reason — R16.

### Phase 3 — the feature this started as
- [ ] Tool-calls in `talk`: `tools`+`tool_choice` in session; handle `function_call` item →
      allow-listed `onTool` → `function_call_output` → `response.create`. Ship one `/lx` tool.
- [ ] Live-monitor: `/lx` launches backgrounded; agent tails the Phase-0 sidecar.
- [ ] Barge-in correctness (R7): `response.cancel` + `conversation.item.truncate`, drop stale deltas.

## Verify each phase live (real wss), review diff with a research lane before advancing.

---

## STATUS (2026-08-18)

**Phase 0 — DONE & verified.** `openRealtime()` shared helper (+ `perMessageDeflate:false`);
sidecar JSONL logger (the live-monitor transport) verified streaming both sides + every ws
event + latency, flushed per line.

**Phase 1 — BUILT, compiles, greeting-verified.** Verified live when the endpoint cooperates:
greeting generates and completes cleanly (`response.done`, no mid-response abort), first word
~1288–1414ms, config accepted (`gpt-4o-mini-transcribe` transcription + `noise_reduction` +
`idle_timeout_ms` at connect), sidecar logging, low-delay ffplay flags, no crash.
- Dropped the transcription **hot-add** (row-3, ~90ms): resending `turn_detection` mid-response
  makes the server abort the call (observed). Transcription now at connect-time. The daemon
  (Phase 2) makes the 90ms moot anyway.
- Dropped ffplay **pre-spawn** (row-4): `-autoexit` on an empty pipe exits 123. Low-delay flags
  kept; player spawns lazily with a bounded restart supervisor.
- Added: mic-death supervisor (R1), per-turn ffplay-death supervisor bounded (R6), orphan
  cleanup on all signals (R5), whisper hangup-guard ≥400ms speech (R10c), noise_reduction (R9),
  idle_timeout_ms (R15), backpressure (R8), pending-array + `.failed` (R11), **connect-timeout
  watchdog** (new — a stalled connect used to hang forever).

**VERIFICATION WALL (this sandbox):** the mic can't be opened (`avfoundation … Input/output
error`), so a full **two-way conversation** (mic → transcription → hangup) is NOT testable here;
only the greeting/output half is. The realtime endpoint also rate-limits rapid reconnects
(flaky connect during heavy testing). → Phases 2 (daemon) & 3 (tools/barge/monitor) can be BUILT
compile-clean + logic-reviewed here, but their conversational behavior must be verified on a real
machine with mic access.
