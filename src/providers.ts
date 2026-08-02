// providers.ts — one adapter per vendor. Everything vendor-specific (where the
// subscription credential lives, the endpoint, the request shape, how a stream
// event becomes text) is behind this interface; the engine knows none of it.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { HOME, IS_MAC } from "./platform.ts";
import type { Model, ProviderId } from "./registry.ts";
import { ANTHROPIC_EFFORTS } from "./registry.ts";

export type ImageRef = { url?: string; mediaType?: string; base64?: string };
export type Turn = { role: "user" | "assistant"; text: string; images?: ImageRef[] };
export type CallOpts = {
  effort?: string; maxTokens?: number; system?: string; thinkOff?: boolean;
  showThinking?: boolean; fast?: boolean; oneM?: boolean; temperature?: number;
  /** Ask the model to draw: adds the provider's image-generation tool to the request. */
  genImage?: boolean; imageSize?: string; imageQuality?: string;
  /** Send the drawing prompt through untouched instead of letting the model rewrite it. */
  rawPrompt?: boolean;
};

/** Text-to-speech is a different shape from a chat call: one request, binary back. */
export type SpeechOpts = { text: string; voice: string; format: string; model?: string; speed?: number };
export type SpeechResult = { bytes: Uint8Array; contentType: string };
export type Creds = { token: string; account?: string; expiresAt?: number; source: string };
export type Built = { url: string; headers: Record<string, string>; body: any };
/**
 * What one stream event contributed. `text` is answer content, `reasoning` is
 * thinking, and `served` is the model id the API itself reports — the only
 * trustworthy proof of which model answered (a model's self-description is not).
 */
export type Delta = {
  text?: string; reasoning?: string; error?: string; served?: string;
  /** base64 image data produced by an image-generation tool call. */
  imageB64?: string;
  /** the model's rewritten version of the drawing prompt, when it reports one. */
  revisedPrompt?: string;
  /** progress note worth showing while a slow non-text job runs. */
  progress?: string;
};

export interface Provider {
  id: ProviderId;
  label: string;
  /** Where the login lives, for `apiplan status` — never throws. */
  probe(): { connected: boolean; detail: string; loginHint: string };
  /** Throws Error (with a fix-it message) when not logged in. */
  creds(): Creds;
  efforts(m: Model): string[];
  build(m: Model, turns: Turn[], o: CallOpts, c: Creds): Built;
  delta(ev: any): Delta;
  /** Can this provider draw? Absent means no, and the CLI says so by name. */
  canGenerateImages?: boolean;
  /** Text to speech. Absent means the provider offers none here. Throws with a
   *  fix-it message when the credential in hand doesn't cover it. */
  speak?(o: SpeechOpts): Promise<SpeechResult>;
  /** Voices this provider accepts, for `--help` and validation. */
  voices?: string[];
  /** Voices the live backend serves right now (a local server may offer its own). */
  listVoices?(): Promise<{ backend: string; voices: string[] }>;
  /** Speak a message that already exists in the account — the subscription's own
   *  read-aloud. No API key, real product voices, but it can only read what is
   *  already there: see readAloud's note for why arbitrary text can't go through it. */
  readAloud?(o: AloudOpts): Promise<SpeechResult & { spoke: string; voice: string }>;
  /** The read-aloud voices this account is entitled to, live. */
  aloudVoices?(): Promise<{ selected: string; voices: string[] }>;
}
export type AloudOpts = { conversation?: string; message?: string; voice?: string; format?: string;
  /** Explicit opt-in to touching stored history at all. Never implied. */ last?: boolean };

/** The voices the realtime endpoint serves (it names them itself when you send a bad one). */
export const REALTIME_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

/** PCM16 mono → a .wav file. 44 bytes of header is the whole "codec". */
function wav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.from(pcm)]));
}

/**
 * Speak text through the realtime endpoint using the ChatGPT subscription token.
 * One WebSocket, one response, PCM16 back. The model is told to read the text
 * verbatim — it is a conversational model being used as a narrator, so the
 * instruction matters.
 */
export function speakRealtime(c: Creds, o: SpeechOpts, timeoutMs = 120000): Promise<SpeechResult> {
  const model = o.model || env("APIPLAN_REALTIME_MODEL", "gpt-realtime");
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    // No OpenAI-Beta header: the beta shape is retired and answers beta_api_shape_disabled.
    try { ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${c.token}` } } as any); }
    catch (e: any) { return reject(new Error(`realtime speech could not connect: ${e?.message ?? e}`)); }

    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} ; fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("realtime speech timed out"))), timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", output_modalities: ["audio"],
        audio: { output: { voice: o.voice, format: { type: "audio/pcm", rate: 24000 } } } } }));
      ws.send(JSON.stringify({ type: "response.create", response: {
        instructions: `Read the following text aloud, verbatim, and say nothing else — no greeting, no comment:\n\n${o.text}` } }));
    };
    ws.onmessage = (e: any) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (typeof ev.type === "string" && ev.type.endsWith("audio.delta") && ev.delta) chunks.push(Buffer.from(ev.delta, "base64"));
      else if (ev.type === "error") done(() => reject(new Error(`realtime speech refused: ${ev.error?.message ?? "unknown error"}`)));
      else if (ev.type === "response.done") {
        const pcm = Buffer.concat(chunks);
        if (!pcm.length) return done(() => reject(new Error("realtime speech returned no audio")));
        done(() => resolve({ bytes: wav(pcm), contentType: "audio/wav" }));
      }
    };
    ws.onerror = () => done(() => reject(new Error("realtime speech connection failed")));
    ws.onclose = (e: any) => done(() => reject(new Error(`realtime speech closed early (${e?.code ?? "?"}) ${String(e?.reason ?? "").slice(0, 120)}`)));
  });
}

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);

// ─────────────────────────── Anthropic (Claude Code subscription) ───────────────────────────

/** macOS keeps it in the Keychain; Linux/WSL/Windows in ~/.claude/.credentials.json. */
function anthropicCredFile(): string {
  return env("APIPLAN_ANTHROPIC_CRED_FILE", join(HOME, ".claude", ".credentials.json"));
}
function readAnthropicRaw(): { json: any; source: string } | null {
  if (IS_MAC) {
    const svc = env("APIPLAN_KEYCHAIN_SERVICE", "Claude Code-credentials");
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", svc, "-w"], { stderr: "ignore" });
    if (r.exitCode === 0 && r.stdout?.length) {
      try { return { json: JSON.parse(r.stdout.toString()), source: `Keychain (${svc})` }; } catch {}
    }
  }
  const f = anthropicCredFile();
  if (existsSync(f)) {
    try { return { json: JSON.parse(readFileSync(f, "utf8")), source: f.replace(HOME, "~") }; } catch {}
  }
  return null;
}

/** Modern contract: output_config.effort + adaptive thinking. Legacy: budget_tokens. */
const MODERN_THINKING = (id: string) => /opus-(5|4-(5|6|7|8))|sonnet-5|sonnet-4-6|fable-5|mythos-5/.test(id);
const LEGACY_BUDGET: Record<string, number> = { low: 0, medium: 4000, high: 10000, xhigh: 24000, max: 48000 };
const HIGH_EFFORT = new Set(["high", "xhigh", "max"]);

export const anthropic: Provider = {
  id: "anthropic",
  label: "Anthropic (Claude Code subscription)",
  probe() {
    const raw = readAnthropicRaw();
    const t = raw?.json?.claudeAiOauth;
    if (!t?.accessToken) {
      return { connected: false, detail: IS_MAC ? "no Keychain entry / cred file" : `no ${anthropicCredFile().replace(HOME, "~")}`, loginHint: "run `claude` and log in" };
    }
    const exp = t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 16).replace("T", " ") : "unknown";
    const stale = t.expiresAt && t.expiresAt < Date.now();
    return {
      connected: !stale,
      detail: stale ? `token expired (${exp})` : `${raw!.source} · expires ${exp}${t.subscriptionType ? ` · ${t.subscriptionType}` : ""}`,
      loginHint: stale ? "run `claude` once to refresh the token" : "",
    };
  },
  creds() {
    const raw = readAnthropicRaw();
    const t = raw?.json?.claudeAiOauth;
    if (!t?.accessToken) throw new Error(`no Claude subscription credential (${IS_MAC ? "Keychain" : anthropicCredFile()}) — run \`claude\` and log in first.`);
    if (t.expiresAt && t.expiresAt < Date.now()) throw new Error("Claude OAuth token expired — run `claude` once to refresh it.");
    return { token: t.accessToken, expiresAt: t.expiresAt, source: raw!.source };
  },
  efforts: (m) => m.efforts ?? ANTHROPIC_EFFORTS,
  build(m, turns, o, c) {
    const betas = [env("APIPLAN_OAUTH_BETA", "oauth-2025-04-20")];
    if (o.oneM) betas.push("context-1m-2025-08-07");
    if (o.fast) betas.push("fast-mode-2026-02-01");
    // system[0] must be the Claude Code identity line: the subscription token is
    // only accepted for Claude Code traffic. The user's prompt is appended after.
    const system: any[] = [{ type: "text", text: env("APIPLAN_IDENTITY", "You are Claude Code, Anthropic's official CLI for Claude.") }];
    if (o.system) system.push({ type: "text", text: o.system });

    const body: any = { model: m.id, system, messages: turns.map(toAnthropicMsg) };
    if (o.fast) body.speed = "fast";

    if (MODERN_THINKING(m.id)) {
      if (o.thinkOff) body.thinking = { type: "disabled" };
      else if (o.effort) body.thinking = o.showThinking ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
      if (o.effort) body.output_config = { effort: o.effort };
      body.max_tokens = o.maxTokens ?? (o.effort && HIGH_EFFORT.has(o.effort) ? 32000 : 8192);
    } else {
      const budget = o.thinkOff ? 0 : LEGACY_BUDGET[o.effort ?? ""] ?? 0;
      if (budget > 0) betas.push("interleaved-thinking-2025-05-14");
      body.max_tokens = o.maxTokens ?? (budget > 0 ? budget + 8192 : 8192);
      if (budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
      else if (o.temperature !== undefined) body.temperature = o.temperature;
    }
    return {
      url: `${env("APIPLAN_ANTHROPIC_BASE", "https://api.anthropic.com")}/v1/messages?beta=true`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
        "anthropic-version": env("APIPLAN_API_VERSION", "2023-06-01"),
        "anthropic-beta": betas.join(","),
        "anthropic-client-platform": "cli",
        "x-app": "cli",
      },
      body,
    };
  },
  delta(ev) {
    if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") return { text: ev.delta.text };
      if (ev.delta?.type === "thinking_delta") return { reasoning: ev.delta.thinking };
      return {};
    }
    if (ev.type === "message_start") return { served: ev.message?.model };
    if (ev.type === "error") return { error: ev.error?.message ?? "stream error" };
    return {};
  },
};
function toAnthropicMsg(t: Turn) {
  if (!t.images?.length) return { role: t.role, content: t.text };
  const content: any[] = [];
  if (t.text) content.push({ type: "text", text: t.text });
  for (const im of t.images) {
    content.push(im.url
      ? { type: "image", source: { type: "url", url: im.url } }
      : { type: "image", source: { type: "base64", media_type: im.mediaType, data: im.base64 } });
  }
  return { role: t.role, content };
}

// ─────────────────────────── OpenAI (Codex / ChatGPT subscription) ───────────────────────────

const codexAuthFile = () => env("APIPLAN_CODEX_AUTH", join(HOME, ".codex", "auth.json"));
function readCodexRaw(): any | null {
  const f = codexAuthFile();
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function jwtExp(tok: string): number | undefined {
  try { const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString()); return p.exp ? p.exp * 1000 : undefined; } catch { return undefined; }
}

export const openai: Provider = {
  id: "openai",
  label: "OpenAI (Codex / ChatGPT subscription)",
  probe() {
    const a = readCodexRaw();
    if (!a) return { connected: false, detail: `no ${codexAuthFile().replace(HOME, "~")}`, loginHint: "run `codex` and log in" };
    const tok = a?.tokens?.access_token;
    if (!tok) {
      return a.OPENAI_API_KEY
        ? { connected: false, detail: "API-key mode, not a ChatGPT subscription", loginHint: "log in with ChatGPT inside `codex`" }
        : { connected: false, detail: "auth.json has no tokens.access_token", loginHint: "run `codex` and log in" };
    }
    const exp = jwtExp(tok);
    const stale = exp !== undefined && exp < Date.now();
    const when = exp ? new Date(exp).toISOString().slice(0, 16).replace("T", " ") : "unknown";
    return {
      connected: !stale,
      detail: stale ? `token expired (${when})` : `${codexAuthFile().replace(HOME, "~")} · ${a.auth_mode ?? "chatgpt"} · expires ${when}`,
      loginHint: stale ? "run `codex` once to refresh the token" : "",
    };
  },
  creds() {
    const a = readCodexRaw();
    if (!a) throw new Error(`no ${codexAuthFile()} — run \`codex\` and log in first.`);
    const t = a.tokens;
    if (!t?.access_token) throw new Error(a.OPENAI_API_KEY ? "auth.json is API-key mode, not a ChatGPT subscription." : "auth.json has no tokens.access_token — run `codex` and log in.");
    const exp = jwtExp(t.access_token);
    if (exp && exp < Date.now()) throw new Error("Codex OAuth token expired — run `codex` once to refresh it.");
    return { token: t.access_token, account: t.account_id ?? a.account_id, expiresAt: exp, source: codexAuthFile().replace(HOME, "~") };
  },
  efforts: (m) => m.efforts ?? ["low", "medium", "high", "xhigh"],
  build(m, turns, o, c) {
    const body: any = {
      model: m.id,
      instructions: o.system ?? "",
      input: turns.map(toResponsesItem),
      store: false,
      stream: true,
    };
    if (o.effort) body.reasoning = { effort: o.effort, ...(o.showThinking ? { summary: "auto" } : {}) };
    if (o.maxTokens) body.max_output_tokens = o.maxTokens;
    // Drawing runs as a built-in tool on the SAME subscription endpoint as chat —
    // verified live: the backend returns base64 in an image_generation_call.
    if (o.genImage) {
      // The model — not the image backend — is what rewrites a drawing prompt: it
      // decides the tool-call arguments, which is why `prompt used:` differs from what
      // you typed. --raw removes that liberty; the default keeps it, because the
      // rewrite genuinely helps a terse prompt.
      if (o.rawPrompt) {
        body.instructions = (o.system ? o.system + "\n\n" : "") +
          "Call the image_generation tool exactly once. Its `prompt` argument MUST be the user's " +
          "message copied character for character — do not rewrite, expand, translate, summarise, " +
          "reorder, add style words, or add detail of any kind. Reply with no text.";
      }
      const tool: any = { type: "image_generation" };
      if (o.imageSize) tool.size = o.imageSize;
      if (o.imageQuality) tool.quality = o.imageQuality;
      body.tools = [...(body.tools ?? []), tool];
    }
    return {
      url: `${env("APIPLAN_OPENAI_BASE", "https://chatgpt.com")}${env("APIPLAN_RESPONSES_PATH", "/backend-api/codex/responses")}`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${c.token}`,
        "chatgpt-account-id": c.account ?? "",
        originator: env("APIPLAN_ORIGINATOR", "codex_cli_rs"),
        session_id: crypto.randomUUID(),
      },
      body,
    };
  },
  delta(ev) {
    switch (ev.type) {
      case "response.created": case "response.in_progress": return { served: ev.response?.model };
      case "response.output_text.delta": return { text: ev.delta ?? "" };
      // Image generation: progress first, then the finished base64 — which arrives
      // either on the item-done event or inside the final response's output list.
      case "response.image_generation_call.in_progress": return { progress: "drawing…" };
      case "response.image_generation_call.generating": return { progress: "rendering…" };
      case "response.image_generation_call.partial_image": return { progress: "partial…" };
      case "response.image_generation_call.completed":
        return { imageB64: ev.result ?? ev.item?.result, revisedPrompt: ev.revised_prompt ?? ev.item?.revised_prompt };
      case "response.output_item.done":
        if (ev.item?.type === "image_generation_call") {
          return { imageB64: ev.item.result, revisedPrompt: ev.item.revised_prompt };
        }
        return {};
      case "response.completed": {
        for (const it of ev.response?.output ?? []) {
          if (it?.type === "image_generation_call" && it.result) return { imageB64: it.result, revisedPrompt: it.revised_prompt };
        }
        return {};
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": return { reasoning: ev.delta ?? "" };
      case "response.failed": return { error: ev.response?.error?.message ?? "response failed" };
      case "response.error": case "error": return { error: ev.error?.message ?? ev.message ?? "stream error" };
      default: return {};
    }
  },
  canGenerateImages: true,
  voices: REALTIME_VOICES,
  /**
   * Read-aloud — the ChatGPT product's own TTS, and the ONE speech path the
   * subscription really does cover. `GET /backend-api/synthesize` returns audio/aac
   * in the nine ChatGPT product voices for a message that already exists in the
   * account. Measured working 2026-08-02.
   *
   * It reads a stored message and only that: there is no text parameter (probed —
   * text/message/content/input/prompt/ssml are all ignored), and putting new text
   * into the account means POST /backend-api/conversation, which is behind ChatGPT's
   * anti-automation proof-of-work sentinel (403 "Unusual activity"). So this speaks
   * what is in your history; arbitrary text still needs speak() or --local.
   */
  async readAloud(o: AloudOpts) {
    const c = openai.creds();
    const H = { authorization: `Bearer ${c.token}`, ...(c.account ? { "chatgpt-account-id": c.account } : {}) };
    const get = (u: string) => fetch(`https://chatgpt.com${u}`, { headers: H, signal: AbortSignal.timeout(45000) });

    let { conversation, message } = o;
    let spoke = "";
    if (!conversation || !message) {
      // Newest conversation, newest assistant message in it. `aloud` names what it
      // does, so needing a second flag to say "yes, the last one" was friction for
      // nothing — but this is the ONLY path that reads stored history, and no other
      // command in apiplan touches it.
      if (!conversation) {
        const list: any = await (await get("/backend-api/conversations?limit=1&offset=0")).json();
        conversation = list?.items?.[0]?.id;
        if (!conversation) throw new Error("no ChatGPT conversations on this account to read aloud.");
      }
      const det: any = await (await get(`/backend-api/conversation/${conversation}`)).json();
      const turns = Object.values<any>(det?.mapping ?? {})
        .map((n) => n?.message)
        .filter((m) => m?.author?.role === "assistant" && m?.content?.parts?.length)
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
      const last = turns[turns.length - 1];
      if (!last) throw new Error(`conversation ${conversation} has no assistant message to read.`);
      message = last.id;
      spoke = last.content.parts.filter((p: any) => typeof p === "string").join(" ").trim();
    }
    const voice = o.voice || (await openai.aloudVoices!()).selected;
    const format = o.format || "aac";
    const res = await get(`/backend-api/synthesize?conversation_id=${conversation}&message_id=${message}&voice=${encodeURIComponent(voice)}&format=${encodeURIComponent(format)}`);
    if (!res.ok) {
      const d = (await res.text()).slice(0, 200);
      throw new Error(`read-aloud failed (${res.status}): ${d}\n  conversation=${conversation} message=${message}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "audio/aac", spoke, voice };
  },
  /** The account's real ChatGPT voices — asked live, never a hardcoded guess. */
  async aloudVoices() {
    const c = openai.creds();
    const r = await fetch("https://chatgpt.com/backend-api/settings/voices", {
      headers: { authorization: `Bearer ${c.token}`, ...(c.account ? { "chatgpt-account-id": c.account } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`could not list ChatGPT voices (${r.status})`);
    const j: any = await r.json();
    return { selected: j?.selected ?? "cove", voices: (j?.voices ?? []).map((v: any) => v.voice).filter(Boolean) };
  },
  /**
   * Speech from arbitrary text, on the subscription — no API key, no conversation,
   * nothing stored. The realtime endpoint accepts the ChatGPT OAuth token over a
   * plain WebSocket (the GA shape: send no `OpenAI-Beta` header, or it answers
   * `beta_api_shape_disabled`), and streams back raw PCM16 at 24 kHz, which needs a
   * 44-byte WAV header and no codec at all.
   *
   * Measured 2026-08-02: `/v1/audio/speech` still refuses a subscription token (429
   * "account is not active"), so the billed REST route is the fallback here, not the
   * main path.
   */
  async speak(o: SpeechOpts): Promise<SpeechResult> {
    const key = process.env.OPENAI_API_KEY || process.env.APIPLAN_OPENAI_API_KEY;
    const base = process.env.APIPLAN_TTS_BASE;
    if (!base) {
      try { return await speakRealtime(openai.creds(), o); }
      catch (e) { if (!key) throw e; }        // with a key in hand, fall through and use it
    }
    const url = base || env("APIPLAN_OPENAI_API_BASE", "https://api.openai.com");
    const model = o.model || env("APIPLAN_TTS_MODEL", "gpt-4o-mini-tts");
    const res = await fetch(`${url}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, voice: o.voice, input: o.text, response_format: o.format, ...(o.speed ? { speed: o.speed } : {}) }),
    });
    if (!res.ok) {
      let detail = (await res.text()).slice(0, 300);
      try { detail = JSON.parse(detail)?.error?.message ?? detail; } catch {}
      throw new Error(`speech failed (${res.status}) via ${url}: ${detail}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || `audio/${o.format}` };
  },
  /** Voices the chosen backend actually serves (local server asked live, else OpenAI's). */
  async listVoices(): Promise<{ backend: string; voices: string[] }> {
    const base = process.env.APIPLAN_TTS_BASE;   // only when explicitly configured
    if (!base) return { backend: "realtime (your ChatGPT subscription)", voices: REALTIME_VOICES };
    if (base) {
      try {
        const r = await fetch(`${base}/v1/audio/voices`);
        const j: any = await r.json();
        const v = Array.isArray(j?.voices) ? j.voices : Array.isArray(j) ? j : Object.keys(j ?? {});
        if (v.length) return { backend: base, voices: v };
      } catch {}
    }
    return { backend: "api.openai.com (needs OPENAI_API_KEY)", voices: openai.voices ?? [] };
  },
};
/** Responses API items: user content is input_text/input_image, assistant is output_text. */
function toResponsesItem(t: Turn) {
  const content: any[] = [];
  if (t.role === "assistant") {
    content.push({ type: "output_text", text: t.text });
  } else {
    if (t.text) content.push({ type: "input_text", text: t.text });
    for (const im of t.images ?? []) {
      content.push({ type: "input_image", image_url: im.url ?? `data:${im.mediaType};base64,${im.base64}` });
    }
  }
  return { type: "message", role: t.role, content };
}

export const PROVIDERS: Record<ProviderId, Provider> = { anthropic, openai };
export const providerFor = (m: Model): Provider => PROVIDERS[m.provider];
