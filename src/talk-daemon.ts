// talk-daemon.ts — the warm voice path: the daemon holds a realtime socket that is
// already connected AND already configured, so `apiplan talk` starts a conversation
// without paying for either.
//
// Why this file exists, in numbers (all measured live, see VOICE_UPGRADE_PLAN.md):
// a cold `talk` spends ~1200-1400ms before the first spoken word, and only ~65ms of
// that is ours. ~565ms is the WS-101 upgrade — OpenAI allocating a realtime session
// server-side — and another ~330ms is the two config round-trips that follow it.
// TLS is ~15ms, i.e. 1%, which is why every TLS idea in the plan is a dead end.
// Park the socket through both of those costs and first audio lands at 517-555ms.
//
// The park has to stay GENERIC to be reusable, so it carries no persona: the caller's
// `direction` goes into `response.instructions` on the greeting, never into the session.
// Anything that IS baked into the socket — the model (it is in the URL), the voice and
// the noise-reduction profile (they are session config) — is compared at call time, and
// a mismatch costs either one round-trip (voice/barge: re-send the config) or the whole
// park (model: the URL cannot be changed, so that call connects cold).
//
// The daemon, not the CLI, owns ffmpeg and ffplay. Audio devices do not need a tty, so
// a detached daemon can hold the microphone and the speaker perfectly well, and the CLI
// shrinks to a pipe that renders the transcript.
import { openai, openRealtime } from "./providers.ts";
import { ipc, ipcTarget } from "./platform.ts";
import { VERSION } from "./engine.ts";

const RATE = 24000;
const DEFAULT_VOICE = "cedar";
const realtimeModel = () => process.env.APIPLAN_REALTIME_MODEL || "gpt-realtime";
const defaultVoice = () => process.env.APIPLAN_VOICE || DEFAULT_VOICE;

/** What the thin CLI sends to POST /talk. A subset of TalkOpts: the daemon supplies
 *  the socket and the audio devices, so those are not the caller's to choose. */
export type TalkReq = {
  voice?: string;
  model?: string;
  direction?: string;
  greet?: boolean | string;
  barge?: boolean;
  hangup?: string[];
  logFile?: string;
};

/** One line of the NDJSON the daemon streams back. `end` is always last. */
export type TalkEvent =
  | { kind: "you" | "model" | "info"; text: string }
  | { kind: "end"; reason: string };

// ───────────────────────────── the park ─────────────────────────────

type ParkState = "cold" | "connecting" | "ready" | "inuse" | "dead";

type Park = {
  ws: WebSocket;
  model: string;
  voice: string;
  barge: boolean;
  state: ParkState;
  openedAt: number;
  readyAt: number;
  /** Unix ms the server says this session dies at, from `session.created`. 0 = unknown. */
  expiresAtMs: number;
  error: string;
};

let park: Park | null = null;
/** One conversation at a time: two calls would fight over the same microphone. */
let busy = false;
/** The socket the CURRENT call is speaking through — the only handle that can cancel it. */
let live: WebSocket | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let fails = 0;
let lastReason = "";
/** A short ring of server event types seen while parked. The park is supposed to be
 *  silent; anything in here is evidence about what the server does to an idle session. */
const idleEvents: string[] = [];

/** Log a park-lifecycle line to stderr only when asked — the daemon's stderr is usually
 *  /dev/null, and a silent daemon is the normal case. */
const trace = (s: string) => {
  lastReason = s;
  if (process.env.APIPLAN_TALK_PARK_DEBUG) { try { process.stderr.write(`[park] ${s}\n`); } catch {} }
};

/**
 * The session config the park is created with. It is deliberately IDENTICAL to the one
 * src/talk.ts sends on a cold connect — if the two ever drift, a parked call and a cold
 * call stop behaving the same way and the difference is invisible until someone reports
 * that "the daemon one sounds different". Keep them in sync on purpose.
 *
 * `instructions` is absent by design: persona per call, in `response.instructions`.
 */
function sessionConfig(voice: string, barge: boolean) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: RATE },
          // gpt-4o-mini-transcribe hallucinates far less than whisper-1 on near-silence.
          transcription: { model: process.env.APIPLAN_TRANSCRIBE || "gpt-4o-mini-transcribe" },
          // near_field assumes headphones (which barge-in already requires); far_field
          // suits a laptop/room mic and keeps the speaker's own voice out of the VAD.
          noise_reduction: { type: barge ? "near_field" : "far_field" },
          turn_detection: { type: "server_vad", threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 800, idle_timeout_ms: 15000 },
        },
        output: { voice, format: { type: "audio/pcm", rate: RATE } },
      },
    },
  };
}

/** Everything the park promises a caller. A call may reuse a socket only when all three
 *  match, or (for voice/barge) after paying one round-trip to re-configure. */
const parkMatches = (p: Park, model: string) => p.model === model;

/**
 * Open a realtime socket and configure it, resolving only once the server has ACKed the
 * config (`session.updated`). Both costs the caller would otherwise pay — the WS upgrade
 * and the config round-trip — are paid HERE, in the background, before anyone asks.
 */
function openParked(model: string, voice: string, barge: boolean): Promise<Park> {
  return new Promise<Park>((resolve, reject) => {
    let ws: WebSocket;
    try {
      const c = openai.creds();
      ws = openRealtime(c.token, model);
    } catch (e: any) {
      return reject(new Error(`cannot open realtime socket: ${e?.message ?? e}`));
    }
    const p: Park = {
      ws, model, voice, barge, state: "connecting",
      openedAt: Date.now(), readyAt: 0, expiresAtMs: 0, error: "",
    };
    let settled = false;
    // A stalled upgrade otherwise hangs with no event at all — the realtime endpoint
    // rate-limits rapid reconnects by simply not answering, which is exactly what a
    // park-retry storm produces. Fail fast so the backoff can do its job.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.state = "dead";
      p.error = "connect timed out";
      try { ws.close(); } catch {}
      reject(new Error("park connect timed out"));
    }, Number(process.env.APIPLAN_CONNECT_MS) || 12000);

    ws.onopen = () => { try { ws.send(JSON.stringify(sessionConfig(voice, barge))); } catch {} };
    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (ev.type === "session.created" || ev.type === "session.updated") {
        // expires_at is unix SECONDS in the realtime API. Guard anyway: a value that is
        // already in ms would otherwise schedule a rotation ~50000 years out.
        const raw = Number(ev.session?.expires_at ?? 0);
        if (raw > 0) p.expiresAtMs = raw > 1e12 ? raw : raw * 1000;
      }
      if (ev.type === "session.updated" && !settled) {
        settled = true;
        clearTimeout(timer);
        p.state = "ready";
        p.readyAt = Date.now();
        resolve(p);
        return;
      }
      if (ev.type === "error" && !settled) {
        settled = true;
        clearTimeout(timer);
        p.state = "dead";
        p.error = ev.error?.message ?? "realtime error";
        try { ws.close(); } catch {}
        reject(new Error(p.error));
        return;
      }
      // Parked and configured, nobody talking: record what the server says unprompted.
      if (p.state === "ready") {
        idleEvents.push(`${new Date().toISOString().slice(11, 19)} ${ev.type}`);
        if (idleEvents.length > 12) idleEvents.shift();
      }
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.state = "dead";
      p.error = "connection failed";
      reject(new Error("park connection failed"));
    };
    ws.onclose = (e: any) => {
      p.state = "dead";
      p.error ||= `socket closed (${e?.code ?? "?"})`;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(p.error)); }
      // A park that dies on its own (server rotation, network drop, token expiry) must
      // heal without waiting for a caller to discover it the slow way.
      else if (park === p) { park = null; trace(`park died: ${p.error}`); scheduleRepark(); }
    };
  });
}

/** Backoff so a park that cannot connect does not hammer an endpoint that is already
 *  rate-limiting us. Reset on every success. */
function scheduleRepark() {
  if (retryTimer || busy) return;
  const wait = Math.min(1000 * 2 ** Math.min(fails, 6), 60_000);
  retryTimer = setTimeout(() => { retryTimer = null; armPark("retry"); }, wait);
}

/**
 * Arm the park. Idempotent, never throws, never blocks the caller — the whole point is
 * that the cost is paid on someone else's clock.
 */
export function armPark(reason = ""): void {
  if (busy) return;                                   // a call owns the socket right now
  if (park && park.state !== "dead") return;          // already parked or on its way
  if (process.env.APIPLAN_TALK_PARK === "off") return;
  if (!openai.probe().connected) { trace("not parking: openai not logged in"); return; }

  const model = realtimeModel(), voice = defaultVoice();
  // A placeholder so a second armPark() during the connect does not open a second socket.
  park = { ws: null as any, model, voice, barge: false, state: "connecting", openedAt: Date.now(), readyAt: 0, expiresAtMs: 0, error: "" };
  const pending = park;
  trace(`parking ${model} voice=${voice}${reason ? ` (${reason})` : ""}`);
  openParked(model, voice, false).then(
    (p) => {
      if (park !== pending) { try { p.ws.close(); } catch {} return; }   // superseded/cancelled
      park = p;
      fails = 0;
      trace(`parked in ${p.readyAt - p.openedAt}ms, expires ${p.expiresAtMs ? new Date(p.expiresAtMs).toISOString().slice(11, 19) : "unknown"}`);
      startRotation();
    },
    (e) => {
      if (park === pending) park = null;
      fails++;
      trace(`park failed (${fails}): ${e?.message ?? e}`);
      scheduleRepark();
    },
  );
}

/**
 * Rotate before the session's own cap. Realtime sessions are capped (measured ~60 min);
 * a socket that expires between two turns takes the conversation with it, so retire it
 * 3 minutes early — while nobody is talking — and park a fresh one.
 */
function startRotation() {
  if (rotateTimer) return;
  rotateTimer = setInterval(() => {
    const p = park;
    if (!p || busy) return;
    if (p.state === "dead" || (p.ws && p.ws.readyState !== WebSocket.OPEN)) {
      park = null; trace("park not open — re-parking"); armPark("stale"); return;
    }
    if (p.state !== "ready") return;
    const ageMs = Date.now() - p.openedAt;
    // Two independent guards: what the server told us, and a hard age ceiling for the
    // case where it told us nothing (expires_at missing).
    const dueByExpiry = p.expiresAtMs > 0 && p.expiresAtMs - Date.now() < 180_000;
    const dueByAge = p.expiresAtMs === 0 && ageMs > 50 * 60_000;
    if (dueByExpiry || dueByAge) {
      trace(`rotating park (${dueByExpiry ? "expires_at" : "age"} ${Math.round(ageMs / 1000)}s)`);
      park = null;
      try { p.ws.close(); } catch {}
      armPark("rotation");
    }
  }, 30_000);
  rotateTimer.unref?.();
}

/** Re-send the full session config on an already-open socket and wait for the ACK.
 *  Partial updates are avoided on purpose: nested config objects replace rather than
 *  merge, so sending only `audio.output.voice` risks dropping transcription and VAD —
 *  a bug that would surface as "the daemon call never hears me". One round trip is the
 *  price of a voice change, and it still skips the ~565ms WS upgrade. */
function reconfigure(ws: WebSocket, voice: string, barge: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); ws.onmessage = null as any; resolve(); };
    const t = setTimeout(finish, 4000);   // never hang the call on a missing ACK
    ws.onmessage = (e: any) => {
      let ev: any; try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (ev.type === "session.updated" || ev.type === "error") finish();
    };
    try { ws.send(JSON.stringify(sessionConfig(voice, barge))); } catch { finish(); }
  });
}

// ───────────────────────────── the /talk route ─────────────────────────────

/** Signals talk() installs on the process. In a daemon that runs talk() many times these
 *  accumulate (and the uncaughtException one RETHROWS, which would kill the daemon), so
 *  anything the call added gets removed when it ends. Belt to `manageSignals:false`'s braces. */
const PROC_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "exit", "uncaughtException"] as const;

/**
 * POST /talk — run one conversation inside the daemon and stream its transcript back as
 * newline-delimited JSON. 409 + {"error":"busy"} while another call holds the microphone.
 */
export async function handleTalk(req: Request): Promise<Response> {
  // Check-and-claim with no await in between: two simultaneous requests must not both
  // get past this, or they fight over one microphone and both conversations garble.
  if (busy) {
    return new Response(JSON.stringify({ error: "busy" }), { status: 409, headers: { "content-type": "application/json" } });
  }
  busy = true;

  let r: TalkReq = {};
  try { r = (await req.json()) as TalkReq; } catch { r = {}; }

  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  const push = (ev: TalkEvent) => { try { ctrl?.enqueue(enc.encode(JSON.stringify(ev) + "\n")); } catch {} };

  // The CLI going away (Ctrl-C, closed terminal) must end the call — otherwise the daemon
  // keeps the microphone open forever with nobody listening. Closing the socket is the
  // cancel: talk() ends on `onclose` and tears down ffmpeg/ffplay with it.
  const onAbort = () => { try { live?.close(); } catch {} };
  try { req.signal?.addEventListener("abort", onAbort, { once: true }); } catch {}

  runCall(r, push)
    .catch((e: any) => push({ kind: "info", text: `daemon call failed: ${e?.message ?? e}` }))
    .finally(() => {
      try { req.signal?.removeEventListener("abort", onAbort); } catch {}
      try { ctrl?.close(); } catch {}
      live = null;
      busy = false;
      // Re-park immediately: the next call should find a warm socket, and the cost of
      // building one belongs on this idle moment rather than on that call's clock.
      queueMicrotask(() => armPark("after call"));
    });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-apiplan-version": VERSION },
  });
}

async function runCall(r: TalkReq, push: (ev: TalkEvent) => void): Promise<void> {
  const model = r.model || realtimeModel();
  const voice = r.voice || defaultVoice();
  const barge = !!r.barge;

  let ws: WebSocket | null = null;
  let skipSessionUpdate = false;

  const p = park;
  if (p && p.state === "ready" && p.ws?.readyState === WebSocket.OPEN && parkMatches(p, model)) {
    park = null;                       // no longer parked — this call owns it
    p.state = "inuse";
    ws = p.ws;
    skipSessionUpdate = true;
    const warmFor = Date.now() - p.readyAt;
    if (p.voice !== voice || p.barge !== barge) {
      // One round-trip instead of a whole cold connect. Still ~565ms ahead.
      await reconfigure(ws, voice, barge);
      push({ kind: "info", text: `warm socket re-configured for voice=${voice}${barge ? " barge" : ""}` });
    } else {
      push({ kind: "info", text: `warm socket (parked ${Math.round(warmFor / 1000)}s, 0 round-trips)` });
    }
  } else {
    // Cold. Open the socket HERE anyway rather than letting talk() do it, so the call is
    // still cancellable (see onAbort) — that handle is the only way to stop a conversation
    // whose CLI has walked away.
    const why = !p ? "no park" : p.state !== "ready" ? `park ${p.state}` : !parkMatches(p, model) ? `park is ${p.model}, call wants ${model}` : "park not open";
    push({ kind: "info", text: `cold connect (${why})` });
    try {
      const c = openai.creds();
      ws = openRealtime(c.token, model);
    } catch (e: any) {
      push({ kind: "info", text: `cannot connect: ${e?.message ?? e}` });
      push({ kind: "end", reason: "no-credentials" });
      return;
    }
  }

  live = ws;
  // Clear the park's own handlers before handing the socket over: talk() assigns its own,
  // and a stale onmessage would eat the first events of the conversation.
  ws.onmessage = null as any;
  ws.onopen = null as any;
  ws.onerror = null as any;
  ws.onclose = null as any;

  const before = new Map(PROC_SIGNALS.map((s) => [s, new Set(process.listeners(s as any))]));
  let reason = "closed";
  try {
    const { talk } = await import("./talk.ts");
    // `as any`: socket/skipSessionUpdate/manageSignals are Lane A's additions to TalkOpts.
    // Passing them through an `any` means this file compiles and RUNS today either way —
    // if talk() does not know the fields yet it simply connects cold, which is the exact
    // behaviour we already had. No silent breakage, just no speed win.
    const res: any = await talk({
      model, voice,
      direction: r.direction,
      greet: r.greet,
      barge,
      hangup: r.hangup,
      logFile: r.logFile,
      socket: ws,
      skipSessionUpdate,
      manageSignals: false,
      onEvent: (kind: "you" | "model" | "info", text: string) => push({ kind, text }),
    } as any);
    if (res && typeof res.reason === "string") reason = res.reason;
  } catch (e: any) {
    reason = "error";
    push({ kind: "info", text: e?.message ?? String(e) });
  } finally {
    // If talk() ignored our socket it opened its own and left ours dangling — an orphaned
    // realtime session bills and holds a slot, so close it either way.
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
    for (const s of PROC_SIGNALS) {
      for (const l of process.listeners(s as any)) {
        if (!before.get(s)!.has(l)) { try { process.removeListener(s as any, l as any); } catch {} }
      }
    }
  }
  push({ kind: "end", reason });
}

/** Diagnostics for GET /talk/status — everything needed to answer "why was that call slow?". */
export function parkStatus(): Record<string, unknown> {
  const p = park;
  return {
    version: VERSION,
    busy,
    parked: !!p && p.state === "ready",
    state: p?.state ?? "cold",
    model: p?.model ?? realtimeModel(),
    voice: p?.voice ?? defaultVoice(),
    parkedForMs: p?.readyAt ? Date.now() - p.readyAt : 0,
    connectMs: p?.readyAt ? p.readyAt - p.openedAt : 0,
    expiresInMs: p?.expiresAtMs ? p.expiresAtMs - Date.now() : 0,
    fails,
    last: lastReason,
    idleEvents,
  };
}

/** Close the parked socket politely on daemon shutdown. Never throws, never blocks. */
export function shutdownPark(): void {
  try { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } } catch {}
  try { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } } catch {}
  const p = park; park = null;
  try { p?.ws?.close(); } catch {}
  try { live?.close(); } catch {}
}

/** End the conversation in progress, if any. The socket IS the cancel handle. */
export function cancelTalk(): boolean {
  if (!live) return false;
  try { live.close(); } catch {}
  return true;
}

// ───────────────────────────── the thin CLI side ─────────────────────────────

/**
 * Run a talk call through the daemon and render its transcript.
 *
 * Returns false when there is no usable daemon, which means "caller: go direct". It
 * returns TRUE for a call that ran, including one refused as busy — a second microphone
 * is not a sensible fallback for "the first one is still in use".
 */
export async function talkViaDaemon(
  r: TalkReq,
  render: (kind: "you" | "model" | "info", text: string) => void,
): Promise<boolean> {
  const t = ipcTarget(ipc(), "/talk");
  if (!t) return false;

  // Ctrl-C should hang up rather than orphan a conversation inside the daemon: aborting
  // the request closes the stream, which the daemon sees and turns into a socket close.
  const ac = new AbortController();
  const bye = () => { try { ac.abort(); } catch {} };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, bye);

  let res: Response;
  try {
    res = await fetch(t.url, {
      ...(t.opts as any),
      method: "POST",
      headers: { ...((t.opts as any).headers ?? {}), "content-type": "application/json", "x-apiplan-version": VERSION },
      body: JSON.stringify(r),
      signal: ac.signal,
    } as any);
  } catch {
    return false;                       // nothing listening, or a stale socket file
  }

  if (res.status === 409) {
    // 409 is overloaded on this daemon: /call uses it for a build mismatch, /talk for a
    // call already in progress. The body tells them apart.
    const txt = await res.text().catch(() => "");
    let j: any; try { j = JSON.parse(txt); } catch {}
    if (j?.error === "busy") {
      render("info", "the daemon is already on a call — hang that one up first, or use --direct");
      return true;
    }
    return false;                       // version mismatch → the caller replaces the daemon
  }
  if (!res.ok || !res.body) return false;

  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Split on newlines and KEEP the remainder: a JSON object that straddles two chunks
      // is the normal case on a busy stream, and a naive split corrupts it.
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.kind === "end") continue;
        if (ev.kind === "you" || ev.kind === "model" || ev.kind === "info") render(ev.kind, String(ev.text ?? ""));
      }
    }
  } catch {
    // Aborted by Ctrl-C, or the daemon exited mid-call. Either way the transcript above
    // is what happened; there is nothing to recover.
  } finally {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(sig, bye);
  }
  return true;
}

/** GET /talk/status through the daemon, for `apiplan doctor` and the bench harness. */
export async function daemonParkStatus(): Promise<Record<string, unknown> | null> {
  const t = ipcTarget(ipc(), "/talk/status");
  if (!t) return null;
  try {
    const r = await fetch(t.url, t.opts as any);
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch { return null; }
}
