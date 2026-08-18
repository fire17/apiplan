#!/usr/bin/env bun
// park-probe.ts — settle, against the live endpoint, the three assumptions the parked-socket
// design rests on. The repo could not answer any of them (see .grand/reports/rev-daemon.html);
// guessing would have cost a live-debug cycle each, so this asks the server directly.
//
//   idle    Does an idle, configured, mic-less socket get killed or nagged? `turn_detection`
//           carries idle_timeout_ms: 15000. If that counts from session start rather than from
//           the first model turn, every park dies 15s after arming — design-breaking.
//   expiry  Where does the session cap live, and in what unit? Rotation is scheduled off it.
//   voice   (a) Does a PARTIAL session.update preserve audio.input, or wipe transcription/VAD?
//           (b) Can response.create carry a per-response voice? If yes, the park never needs
//               reconfiguring at all, which is strictly better than both alternatives.
//
// Costs one realtime session per mode. Run: bun .grand/verify/park-probe.ts <mode>
import { openai, openRealtime } from "../../src/providers.ts";

const RATE = 24000;
const mode = process.argv[2] || "idle";
const SECS = Number(process.argv[3] || (mode === "idle" ? 75 : 25));
const t0 = Date.now();
const at = () => `+${String(Date.now() - t0).padStart(6)}ms`;
const log = (s: string) => process.stdout.write(`${at()}  ${s}\n`);

const fullConfig = (voice: string, idleTimeout: boolean) => ({
  type: "session.update",
  session: {
    type: "realtime",
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: RATE },
        transcription: { model: "gpt-4o-mini-transcribe" },
        noise_reduction: { type: "far_field" },
        turn_detection: {
          type: "server_vad", threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 800,
          ...(idleTimeout ? { idle_timeout_ms: 15000 } : {}),
        },
      },
      output: { voice, format: { type: "audio/pcm", rate: RATE } },
    },
  },
});

/** The one field that tells us whether a partial update wiped the microphone half. */
const inputSummary = (s: any) => {
  const i = s?.audio?.input;
  if (!i) return "audio.input ABSENT";
  return `audio.input present: transcription=${i.transcription?.model ?? "-"} vad=${i.turn_detection?.type ?? "-"} thr=${i.turn_detection?.threshold ?? "-"} idle=${i.turn_detection?.idle_timeout_ms ?? "-"} nr=${i.noise_reduction?.type ?? "-"}`;
};

const c = openai.creds();
log(`creds from ${c.source}`);
const ws = openRealtime(c.token, process.env.APIPLAN_REALTIME_MODEL || "gpt-realtime");
let updates = 0;
let openedAt = 0;

ws.onopen = () => {
  openedAt = Date.now();
  log(`WS OPEN (upgrade took ${openedAt - t0}ms)`);
  // The idle probe deliberately keeps idle_timeout_ms so we learn what it actually does.
  ws.send(JSON.stringify(fullConfig("cedar", mode !== "no-idle")));
  log("sent full session.update");
};

ws.onmessage = (e: any) => {
  let ev: any;
  try { ev = JSON.parse(String(e.data)); } catch { return log(`unparseable frame`); }

  if (ev.type === "session.created") {
    const s = ev.session ?? {};
    log(`session.created  expires_at=${JSON.stringify(s.expires_at)} (typeof ${typeof s.expires_at}) id=${s.id ?? "-"}`);
    if (typeof s.expires_at === "number") {
      const asSec = new Date(s.expires_at * 1000), asMs = new Date(s.expires_at);
      log(`  as SECONDS -> ${asSec.toISOString()}  (in ${Math.round((s.expires_at * 1000 - Date.now()) / 60000)} min)`);
      log(`  as MILLIS  -> ${asMs.toISOString()}`);
    }
    log(`  ${inputSummary(s)}  voice=${s.audio?.output?.voice ?? "-"}`);
    return;
  }

  if (ev.type === "session.updated") {
    updates++;
    const s = ev.session ?? {};
    log(`session.updated #${updates} (${Date.now() - openedAt}ms after open)  voice=${s.audio?.output?.voice ?? "-"}`);
    log(`  ${inputSummary(s)}`);
    if (typeof s.expires_at === "number") log(`  expires_at=${s.expires_at}`);

    if (mode === "partial" && updates === 1) {
      // CLAIM 1: does a partial update MERGE (audio.input survives) or REPLACE (it vanishes)?
      log("--> sending PARTIAL update: {session:{audio:{output:{voice:'marin'}}}} only");
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { output: { voice: "marin" } } } }));
      return;
    }
    if (mode === "partial" && updates === 2) {
      log(">>> VERDICT claim 1: " + (s?.audio?.input?.turn_detection ? "MERGE — audio.input SURVIVED a partial update" : "REPLACE — audio.input was WIPED; the park must resend its FULL config"));
      return void finish();
    }
    if (mode === "voice" && updates === 1) {
      // CLAIM 3: per-response voice. If accepted, the park is voice-agnostic for free.
      log("--> sending response.create with response.audio.output.voice='marin'");
      ws.send(JSON.stringify({
        type: "response.create",
        response: { instructions: "Say exactly: probe.", audio: { output: { voice: "marin" } } },
      }));
      return;
    }
    return;
  }

  // Everything else, verbatim-ish: the point of the idle probe is what arrives UNASKED.
  const extra = ev.type === "error" ? ` ${ev.error?.code ?? ""} ${String(ev.error?.message ?? "").slice(0, 200)}` : "";
  if (ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") return;   // firehose
  log(`<< ${ev.type}${extra}`);
  if (mode === "voice" && ev.type === "response.done") {
    const v = ev.response?.audio?.output?.voice ?? ev.response?.voice;
    log(`>>> VERDICT claim 3: response.done status=${ev.response?.status} voice-in-response=${JSON.stringify(v)}`);
    finish();
  }
};

ws.onerror = () => log("WS ERROR");
ws.onclose = (e: any) => { log(`WS CLOSE code=${e?.code ?? "?"} reason=${String(e?.reason ?? "").slice(0, 200)}`); process.exit(0); };

function finish() { try { ws.close(); } catch {} setTimeout(() => process.exit(0), 300); }

setTimeout(() => {
  if (mode === "idle") {
    log(`>>> VERDICT claim 4: socket still ${ws.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED"} after ${SECS}s idle with idle_timeout_ms=15000`);
    log(">>> (any unprompted server frames are listed above; none listed = the park is safe to hold)");
  }
  finish();
}, SECS * 1000);
