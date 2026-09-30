export const DEFAULT_LIVE_MODEL = "gpt-realtime";
export const CODEX_LIVE_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

export type LiveModel = {
  id: string;
  aliases: string[];
  transport: "realtime-websocket" | "codex-webrtc" | "gemini-bidi";
  capabilities: { talk: boolean; speechPlayback: boolean; audioFile: boolean; dictation: boolean; functionTools: boolean; park: boolean; vision: boolean };
  evidence: string;
};

const realtimeCapabilities = { talk: true, speechPlayback: true, audioFile: true, dictation: true, functionTools: true, park: true, vision: false };
/**
 * PROVEN 2026-09-29 (scratchpad gpt6/vision-rt-probe.txt): an input_image in conversation.item.create
 * was answered correctly ("MARK 3") on wss://api.openai.com/v1/realtime with the Codex OAuth token —
 * gpt-realtime first text 440-564 ms, gpt-realtime-2.1 521-593 ms. The mini ids were not shown an
 * image, so they keep vision false (proven or false, the same law as the Gemini rows below).
 */
const realtimeSeeing = { ...realtimeCapabilities, vision: true };
/**
 * Gemini's Live API is a DIFFERENT protocol, not a differently-configured Realtime socket,
 * so it gets its own transport rather than being listed as one:
 *   · endpoint `wss://…/ws/google.ai.generativelanguage.v1beta.GenerativeService
 *     .BidiGenerateContent?key=…`, authenticated by API KEY, not an OAuth bearer;
 *   · its own message vocabulary — a `setup` frame answered by `setupComplete`, then
 *     `clientContent`/`realtimeInput` up and `serverContent` down — none of which is
 *     OpenAI's `session.update` / `response.create` / `conversation.item.*` set.
 * The client is src/gemini-live.ts, and its header carries the full measurement log.
 *
 * ── WHAT THE VENDOR REFUSES, IN ITS OWN WORDS ──
 * One handshake per (model, modality), live 2026-09-06, reading the server's 1007 close:
 *   3.1-flash-live-preview        TEXT → 1007 refused    AUDIO → accepted
 *   2.5-flash-native-audio…       TEXT → 1007 refused    AUDIO → accepted
 *   3.5-live-translate-preview    TEXT → accepted        AUDIO → accepted
 *   3.5-transcribe-live           TEXT → accepted        AUDIO → 1007 refused
 * Verbatim: "The requested combination of response modalities (TEXT) is not supported by
 * the model. models/gemini-3.1-flash-live-preview".
 *
 * So the capabilities below are per-model rather than one shared object, and each one is
 * either PROVEN by a live exchange or left false. `requireLiveCapability` refuses anything
 * a model does not declare, which is what turns a false flag into an honest error message
 * instead of a socket that opens and hangs.
 */
/** PROVEN live: audio in → transcription out. See geminiTranscribe below. */
const geminiDictation = { talk: false, speechPlayback: false, audioFile: false, dictation: true, functionTools: false, park: false, vision: false };
/**
 * PROVEN live: audio in → audio out, multi-turn. `talk` and `speechPlayback` are true
 * because a real spoken exchange was completed and its PCM verified; `audioFile` too,
 * because converseBidi() RETURNS the bytes and pcm16Wav() writes them (9.60 s of
 * 24 kHz pcm_s16le, peak 26,822, confirmed by ffprobe).
 *
 * `functionTools` stays FALSE although `setup.tools` is a real wire key: no functionCall
 * has been driven over this transport here, and an unexercised wire field is not a
 * capability. `park` stays FALSE because the warm daemon's parked socket is an OpenAI
 * realtime session (talk-daemon.ts), which this transport is not.
 */
const geminiDialogue = { talk: true, speechPlayback: true, audioFile: true, dictation: false, functionTools: false, park: false, vision: false };
/** Accepted a TEXT setup but answered NOTHING to a text turn, and its audio path was never
 *  driven end to end here. Nothing proven, so nothing claimed. */
const geminiUnproven = { talk: false, speechPlayback: false, audioFile: false, dictation: false, functionTools: false, park: false, vision: false };
export const LIVE_MODELS: readonly LiveModel[] = [
  { id: DEFAULT_LIVE_MODEL, aliases: ["realtime"], transport: "realtime-websocket", capabilities: realtimeSeeing,
    evidence: "Existing APIPlan default; account access is checked when connecting. vision proven 2026-09-29: an input_image turn answered correctly over the subscription socket (first text 440-564 ms)." },
  { id: "gpt-realtime-2.1", aliases: ["realtime-2.1"], transport: "realtime-websocket", capabilities: realtimeSeeing,
    evidence: "Candidate from APIPlan's earlier benchmarks; current account access is not guaranteed. vision proven 2026-09-29: an input_image turn answered correctly over the subscription socket (first text 521-593 ms)." },
  { id: "gpt-realtime-mini", aliases: ["realtime-mini"], transport: "realtime-websocket", capabilities: realtimeCapabilities,
    evidence: "Realtime mini candidate; current account access is checked when connecting." },
  { id: "gpt-realtime-2.1-mini", aliases: ["realtime-2.1-mini"], transport: "realtime-websocket", capabilities: realtimeCapabilities,
    evidence: "Documented OpenAI API model; subscription access has not been tested beyond a handshake (session.created observed 2026-09-29, no turn driven). Distinct from gpt-realtime-mini." },
  { id: "gpt-live-1-codex", aliases: ["codex-live", "live-codex"], transport: "codex-webrtc",
    capabilities: { talk: true, speechPlayback: true, audioFile: false, dictation: false, functionTools: false, park: false, vision: false },
    evidence: "Experimental APIPlan transport, not yet verified live. Observed in Codex Desktop; requires native WebRTC and subscription access. Use live-check." },
  // ── Gemini Live (BidiGenerateContent) ─────────────────────────────────────────────────
  // DRIVABLE as of 2026-09-06 — src/gemini-live.ts is the client. Ids are the vendor's own,
  // as GET /v1beta/models reported them; the registry's route-marked `gemini-key-*` names
  // map onto these (geminiWireId strips the marker for the wire).
  //
  // CACHING, since that is what this lane exists to establish: MEASURED over three live
  // turns carrying a ~5.7k-token systemInstruction — well past the 4,096-token implicit
  // floor — promptTokenCount ran 5782 → 5955 → 6210 and `cachedContentTokenCount` was
  // ABSENT from every single turn. So the implicit prefix cache reported no hit at all on
  // this transport, and nothing a client sends can change that: the SDK's own setup writer
  // has no `cachedContent` key (js-genai _live_converters.ts emits 18 setup keys and that
  // is not one of them), so an explicit CachedContent cannot be referenced over this socket
  // through any supported field. The counter is nonetheless mapped by bidiUsage(), on the
  // rule that a documented field is forwarded rather than dropped.
  { id: "gemini-3.1-flash-live-preview", aliases: ["gemini-live", "gemini-live-3.1"], transport: "gemini-bidi",
    capabilities: geminiDialogue,
    evidence: "DRIVEN LIVE 2026-09-06: three spoken turns in 17.4s via manual activity signalling — 460,834 bytes of 24kHz PCM16 back (9.60s, peak 26,822, ffprobe pcm_s16le/24000/1ch), outputTranscription per reply, usageMetadata per turn. Refuses responseModalities ['TEXT'] with a 1007 close, so it is audio-only; and its AUTOMATIC voice-activity detector never ends an utterance (60s of silence after one ACTIVITY_START), so APIPlan disables it and marks turns by hand." },
  { id: "gemini-2.5-flash-native-audio-preview-12-2025", aliases: ["gemini-live-2.5", "gemini-native-audio"], transport: "gemini-bidi",
    capabilities: geminiDialogue,
    evidence: "Read live from GET /v1beta/models 2026-09-06: declares countTokens + bidiGenerateContent, 131072 in / 8192 out. Refuses ['TEXT'] with the same 1007 close as 3.1-flash-live and accepts ['AUDIO'], so it is driven by the same audio-in/audio-out path; that path is proven on 3.1-flash-live, and this id's own spoken turn has NOT been run." },
  { id: "gemini-3.5-live-translate-preview", aliases: ["gemini-translate-live"], transport: "gemini-bidi",
    capabilities: geminiUnproven,
    evidence: "Read live from GET /v1beta/models 2026-09-06: bidiGenerateContent, 16384 in / 32768 out, speech-to-speech translation, 70+ languages. Accepts a ['TEXT'] setup but answered NOTHING to a clientContent text turn (setupComplete, then silence to a 20s timeout) — it is an audio-input model. Its audio path was not driven here, so no capability is claimed." },
  { id: "gemini-3.5-transcribe-live", aliases: ["gemini-transcribe-live"], transport: "gemini-bidi",
    capabilities: geminiDictation,
    evidence: "DICTATION DRIVEN LIVE 2026-09-06: 108,486 bytes of 16kHz PCM16 in 34 realtimeInput frames returned interimInputTranscription 'acknowledged' and final inputTranscription 'Acknowledged. Happy plan Gemini live transport check.' 1.7s after setup. Refuses ['AUDIO'] with a 1007 close — it is transcription, so `dictation` is the one capability it serves; its automatic detector settles fine and is left on." },
];

export function selectedLiveModel(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  return explicit?.trim() || env.APIPLAN_LIVE_MODEL?.trim() || env.APIPLAN_REALTIME_MODEL?.trim() || DEFAULT_LIVE_MODEL;
}

export function liveModelArgument(argv: string[]): string | undefined {
  for (const flag of ["--live-model", "--realtime-model", "--model"]) {
    const inline = argv.find(arg => arg.startsWith(`${flag}=`));
    const index = argv.indexOf(flag);
    if (inline === undefined && index < 0) continue;
    const value = inline === undefined ? argv[index + 1] : inline.slice(flag.length + 1);
    if (!value?.trim() || value.startsWith("-")) throw new Error(`${flag} needs a model ID (see apiplan live-models).`);
    return value;
  }
  return undefined;
}

/** Unknown Realtime IDs remain usable without editing a catalog. Live IDs must declare a transport. */
export function resolveLiveModel(explicit?: string): LiveModel {
  const selected = selectedLiveModel(explicit);
  const known = LIVE_MODELS.find(m => m.id === selected || m.aliases.includes(selected));
  if (known) return known;
  // Responses models are not Realtime ones: the realtime endpoint answers invalid_model ("Model
  // \"gpt-6-luna\" is not supported in realtime mode", observed 2026-09-29), so refuse before a socket
  // opens instead of treating the id as a custom Realtime model that fails after the handshake.
  if (/^gpt-\d+(?:\.\d+)?-(?:astra|sol|luna|terra)$/.test(selected))
    throw new Error(`${selected} is a Responses model, not a Realtime one (the realtime endpoint answers invalid_model, observed 2026-09-29). For an image use \`luna -i <file>\` (Responses); for live vision use --live-model realtime.`);
  if (selected.startsWith("gpt-live-")) throw new Error(`Unknown live transport for '${selected}'. Use codex-live or a compatible Realtime WebSocket model ID.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(selected)) throw new Error("Invalid live model ID.");
  return { id: selected, aliases: [], transport: "realtime-websocket", capabilities: realtimeCapabilities,
    evidence: "Custom Realtime model; compatibility and account access are unverified." };
}

export function requireLiveCapability(model: LiveModel, capability: keyof LiveModel["capabilities"]): void {
  if (!model.capabilities[capability]) throw new Error(`${model.id} does not support ${capability} in APIPlan. See apiplan live-models.`);
}

/**
 * The id for the OpenAI Realtime WebSocket path, or a refusal that names the ACTUAL
 * transport this model needs. The message used to say "uses Codex WebRTC" for every
 * non-Realtime model, which was true while Codex was the only other transport and became
 * a lie the moment Gemini's Bidi socket was registered — a user told to pass
 * `--live-model codex-live` for a Gemini id would follow the advice and get a second,
 * unrelated failure. So the transport speaks for itself.
 */
const TRANSPORT_HELP: Record<string, string> = {
  "codex-webrtc": "uses Codex WebRTC, not a Realtime WebSocket. Use `apiplan talk --live-model codex-live`, or `--speak --play --live-model codex-live`.",
  // No longer "pending": src/gemini-live.ts drives this transport. The refusal now points
  // at the working command instead of apologising, because the reason a caller lands here
  // is that they asked for a Realtime socket — which is still the wrong socket for a
  // Google model, and always will be.
  "gemini-bidi": "uses Google's BidiGenerateContent WebSocket (src/gemini-live.ts), not a Realtime WebSocket — it authenticates with a Gemini API key and speaks a different protocol. Use `apiplan live-check --live-model gemini-live` for a spoken turn, or `--dictate --live-model gemini-transcribe-live` to transcribe. Audio only: these models refuse a text modality outright.",
};
export function realtimeModelId(explicit?: string): string {
  const model = resolveLiveModel(explicit);
  if (model.transport !== "realtime-websocket") {
    throw new Error(`${model.id} ${TRANSPORT_HELP[model.transport] ?? `uses the ${model.transport} transport, not a Realtime WebSocket.`}`);
  }
  return model.id;
}
