# Voice Models

The voice model is independent of the text model (`sol`, `gpt`, etc.) and the voice
timbre (`cedar`, `alloy`, etc.). The shipped default remains **gpt-realtime**.
Selection does not rewrite configuration or your default command definitions.

```sh
apiplan live-models
apiplan live-models --json
apiplan talk --live-model gpt-realtime-2.1
tts --live-model gpt-realtime-mini --play 'Hello from APIPlan'
tts --live-model gpt-realtime-2.1 --out hello.wav 'Hello'
apiplan live-check --live-model gpt-realtime
```

Precedence: explicit `--live-model` / `--realtime-model`, then `APIPLAN_LIVE_MODEL`,
then the existing `APIPLAN_REALTIME_MODEL`, then `gpt-realtime`. `talk --model`
remains accepted. Custom compatible Realtime WebSocket model IDs are accepted;
unknown `gpt-live-*` IDs are rejected because their transport cannot be inferred.
Explicit model selection never silently falls back to a system voice. Subscription
speech never falls back to a billed API key. A REST speech backend still works when
explicitly configured with `APIPLAN_TTS_BASE`.

Realtime talk compares the selected model against any parked socket. A mismatch
opens the selected model cold. Codex live always runs directly. `--park` only works
with Realtime; an existing daemon configured for another model reports the mismatch.

## Codex Live (Experimental)

The separate adapter implements native WebRTC media plus the Frameless Bidi control
sideband for `gpt-live-1-codex`. Its request structure matches the
[Codex 0.153.4 signaling implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/endpoint/realtime_call.rs)
and [v3 session payload](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs).
The adapter is **not yet verified against a successful live service session**.

```sh
apiplan live-check --live-model codex-live
apiplan talk --live-model codex-live --voice cedar
tts --live-model codex-live --play 'Hello'
# Bounded input-file conversation diagnostic, when service access is available:
apiplan talk --live-model codex-live --input-audio input.wav --duration 20
```

The optional native module must export `LiveWebRtcPeer` and `AudioCapture`.
APIPlan tries `@oh-my-pi/pi-natives`, then the installed OM runtime under
`~/.om/runtime-current`. Set `APIPLAN_LIVE_NATIVE_MODULE` to an absolute module path
for another compatible native build. Plain Bun has no WebRTC peer implementation.
Normal Realtime commands do not load this dependency.

Credentials come from `ACCOUNTTRACKER_BIN codex oauth-access`, or the standard
`~/Creations/AccountTracker/accounttracker` launcher. If AccountTracker is absent,
APIPlan uses its existing Codex subscription reader. A configured or installed
AccountTracker that fails is reported, not bypassed. No tokens are logged or saved.

Implemented capabilities: microphone conversation, transcripts, greeting/persona,
bounded input-file replay, hangup, signal cleanup, and direct speech playback.
The native peer accepts mono 16 kHz float PCM and plays received Opus audio.
Output is playback-only: **no file export, standalone dictation, Realtime function
tools, injection files, stereo positioning, or warm socket parking**. Desktop
task/Astra orchestration is not included. Delegations receive a response explaining
that this host has no tools; it does not pretend to execute them.

## Local Verification: 2026-09-06

| Exact model | Subscription result | Audio evidence |
| --- | --- | --- |
| `gpt-realtime` | Passed | 175,244 WAV bytes, PCM16 peak 23,361 |
| `gpt-realtime-2.1` | Passed | 134,444 WAV bytes, PCM16 peak 22,267 |
| `gpt-realtime-mini` | Passed | 117,644 WAV bytes, PCM16 peak 14,953 |
| `gpt-realtime-2.1-mini` | Not probed | [Documented API model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini); subscription access is unverified |
| `gpt-live-1-codex` | Denied before SDP answer | HTTP 403, `forbidden`, `Voice session access denied.` |

The AccountTracker and existing APIPlan readers returned identical, unexpired
subscription credentials. Adding the installed OM client's DeviceCheck attestation
in one diagnostic attempt produced the same denial. This does not identify whether
the refusal is caused by service policy, account access, or a remaining client
requirement. No successful Codex session, microphone round trip, or output audio is
claimed. Do not treat a catalog entry or mocked test as proof of service access.

Focused tests cover selection/default persistence, distinct mini IDs, capability
guards, AccountTracker payload validation, WebRTC/sideband lifecycle, cancellation,
denial cleanup, audio-drain completion, and absence of billed fallback, plus existing
provider, CLI and API regressions:

```sh
bun test test/live-voice.test.ts test/contract.test.ts test/cli.test.ts test/api.test.ts
```

137 tests passed in the verification run. These do not replace a real Codex live
session test; that remains blocked by the response above.

An end-to-end speech CLI check also passed: `bun bin/ask.ts -m sol --speak
--live-model realtime-2.1 --play --out /tmp/apiplan-voice-sI3xAe/subscription.wav
'APIPlan subscription voice is ready.'` generated a WAV and completed `afplay`.
