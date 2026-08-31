// Public Gemini media generation. This is deliberately separate from the AGY provider:
// AGY's OAuth scope/catalog currently exposes image generation only, while a Gemini API
// key exposes Veo (video), Lyria (music), TTS, and image models.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./platform.ts";
import type { CallOpts, Turn } from "./providers.ts";

const BASE = () => process.env.APIPLAN_GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com";
const KEY_FILE = () => process.env.APIPLAN_GEMINI_API_KEY_FILE ?? join(HOME, ".config", "gemini", "api_key");

export function geminiApiKey(): string {
  const direct = process.env.APIPLAN_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (direct?.trim()) return direct.trim();
  const file = KEY_FILE();
  if (existsSync(file)) {
    const key = readFileSync(file, "utf8").trim();
    if (key) return key;
  }
  throw new Error(`Gemini media generation needs an API key — set APIPLAN_GEMINI_API_KEY or write it to ${file}`);
}

const headers = (key: string) => ({ "content-type": "application/json", "x-goog-api-key": key });
const errorText = async (res: Response) => {
  const raw = await res.text();
  try { return JSON.parse(raw)?.error?.message ?? raw.slice(0, 400); } catch { return raw.slice(0, 400); }
};

export type MediaFile = { bytes: Uint8Array; contentType: string; model: string };

function pcm16Wav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.from(pcm)]));
}

export type PublicGeminiResult = { text: string; model: string; ttft: number; total: number };

/** Public API-key chat/vision route. Useful both as a billed fallback and as a measured
 * latency control against AGY's subscription proxy. */
export async function callGeminiPublic(model: string, turns: Turn[], o: CallOpts, onText?: (text: string) => void, signal?: AbortSignal): Promise<PublicGeminiResult> {
  const key = geminiApiKey();
  const contents = [] as any[];
  for (const turn of turns) {
    const parts: any[] = [];
    if (turn.text) parts.push({ text: turn.text });
    for (const media of turn.images ?? []) {
      if (media.base64) parts.push({ inlineData: { mimeType: media.mediaType ?? "image/png", data: media.base64 } });
      else if (media.url) {
        const r = await fetch(media.url, { signal });
        if (!r.ok) throw new Error(`could not load media URL (${r.status}): ${media.url}`);
        parts.push({ inlineData: { mimeType: media.mediaType ?? r.headers.get("content-type") ?? "application/octet-stream", data: Buffer.from(await r.arrayBuffer()).toString("base64") } });
      }
    }
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts: parts.length ? parts : [{ text: " " }] });
  }
  const generationConfig: any = {};
  if (o.effort) generationConfig.thinkingConfig = { thinkingLevel: o.effort.toUpperCase() };
  if (o.maxTokens) generationConfig.maxOutputTokens = o.maxTokens;
  if (o.temperature !== undefined) generationConfig.temperature = o.temperature;
  const body: any = { contents };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  const started = performance.now();
  const res = await fetch(`${BASE()}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST", headers: headers(key), body: JSON.stringify(body), signal,
  });
  if (!res.ok || !res.body) throw new Error(`public Gemini answered ${res.status}: ${await errorText(res)}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", served = model, ttft = 0, finished = false;
  const accept = (raw: string) => {
    const payload = raw.split(/\r?\n/).filter((x) => x.startsWith("data:")).map((x) => x.slice(5).trim()).join("\n");
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(payload); } catch { return; }
    if (j.error) throw new Error(j.error.message ?? "public Gemini stream error");
    served = j.modelVersion ?? served;
    for (const p of j.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text !== "string" || p.thought) continue;
      if (!ttft) ttft = performance.now() - started;
      text += p.text;
      onText?.(p.text);
    }
    const block = j.promptFeedback?.blockReason;
    if (block && !text) throw new Error(`public Gemini blocked the prompt: ${block}`);
    // The answer is complete the instant a candidate reports why it stopped. Everything
    // after that frame is bookkeeping plus the server's socket teardown; waiting for
    // `done` charges transport cleanup to every otherwise-finished vision call.
    if (j.candidates?.[0]?.finishReason) finished = true;
  };
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i), sep = buf.slice(i).match(/^\r?\n\r?\n/)![0].length;
      buf = buf.slice(i + sep);
      accept(raw);
    }
  }
  if (finished) reader.cancel().catch(() => {});
  else if (buf.trim()) accept(buf);
  return { text, model: served, ttft: ttft || performance.now() - started, total: performance.now() - started };
}

export async function generateGeminiMusic(prompt: string, signal?: AbortSignal): Promise<MediaFile> {
  const key = geminiApiKey();
  const model = process.env.APIPLAN_GEMINI_MUSIC_MODEL ?? "lyria-3-pro-preview";
  const version = process.env.APIPLAN_GEMINI_MUSIC_API_VERSION ?? "v1alpha";
  const res = await fetch(`${BASE()}/${version}/models/${model}:generateContent`, {
    method: "POST", headers: headers(key), signal,
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
  });
  if (!res.ok) throw new Error(`Lyria answered ${res.status}: ${await errorText(res)}`);
  const body: any = await res.json();
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const audio = parts.find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
  const inline = audio?.inlineData ?? audio?.inline_data;
  if (!inline?.data) {
    const why = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason;
    throw new Error(why ? `Lyria generated no audio: ${why}` : "Lyria generated no audio");
  }
  return { bytes: Buffer.from(inline.data, "base64"), contentType: inline.mimeType ?? inline.mime_type ?? "audio/mpeg", model };
}

export async function generateGeminiSpeech(text: string, voice = "Kore", signal?: AbortSignal): Promise<MediaFile> {
  const key = geminiApiKey();
  const model = process.env.APIPLAN_GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
  const res = await fetch(`${BASE()}/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: headers(key), signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS answered ${res.status}: ${await errorText(res)}`);
  const body: any = await res.json();
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const audio = parts.find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
  const inline = audio?.inlineData ?? audio?.inline_data;
  if (!inline?.data) {
    const why = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason;
    throw new Error(why ? `Gemini TTS generated no audio: ${why}` : "Gemini TTS generated no audio");
  }
  const mime = String(inline.mimeType ?? inline.mime_type ?? "audio/L16;rate=24000");
  const bytes = new Uint8Array(Buffer.from(inline.data, "base64"));
  if (/audio\/(?:L16|pcm)/i.test(mime)) {
    const rate = Number(mime.match(/rate=(\d+)/i)?.[1] ?? 24_000);
    return { bytes: pcm16Wav(bytes, rate), contentType: "audio/wav", model };
  }
  return { bytes, contentType: mime, model };
}

export type VideoOptions = { duration?: number; aspectRatio?: string; pollMs?: number; timeoutMs?: number; onProgress?: (note: string) => void };

export async function generateGeminiVideo(prompt: string, o: VideoOptions = {}, signal?: AbortSignal): Promise<MediaFile> {
  const key = geminiApiKey();
  const model = process.env.APIPLAN_GEMINI_VIDEO_MODEL ?? "veo-3.1-fast-generate-preview";
  const parameters: any = { sampleCount: 1 };
  if (o.duration) parameters.durationSeconds = o.duration;
  if (o.aspectRatio) parameters.aspectRatio = o.aspectRatio;
  const start = await fetch(`${BASE()}/v1beta/models/${model}:predictLongRunning`, {
    method: "POST", headers: headers(key), signal,
    body: JSON.stringify({ instances: [{ prompt }], parameters }),
  });
  if (!start.ok) throw new Error(`Veo answered ${start.status}: ${await errorText(start)}`);
  let operation: any = await start.json();
  if (!operation?.name) throw new Error("Veo returned no operation name");
  const began = Date.now();
  const timeout = o.timeoutMs ?? 15 * 60_000;
  const poll = Math.max(1000, o.pollMs ?? 10_000);
  while (!operation.done) {
    if (Date.now() - began > timeout) throw new Error(`Veo operation timed out after ${Math.round(timeout / 1000)}s (${operation.name})`);
    o.onProgress?.(`Veo rendering… ${Math.round((Date.now() - began) / 1000)}s`);
    await Bun.sleep(poll);
    const res = await fetch(`${BASE()}/v1beta/${operation.name}`, { headers: { "x-goog-api-key": key }, signal });
    if (!res.ok) throw new Error(`Veo operation poll answered ${res.status}: ${await errorText(res)}`);
    operation = await res.json();
  }
  if (operation.error) throw new Error(`Veo failed: ${operation.error.message ?? JSON.stringify(operation.error).slice(0, 300)}`);
  const generated = operation?.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
  if (!generated) throw new Error("Veo completed without a generated video");
  const encoded = generated.bytesBase64Encoded ?? generated.data;
  if (encoded) return { bytes: Buffer.from(encoded, "base64"), contentType: generated.mimeType ?? "video/mp4", model };
  if (!generated.uri) throw new Error("Veo completed without video bytes or a download URI");
  const download = await fetch(generated.uri, { headers: { "x-goog-api-key": key }, signal });
  if (!download.ok) throw new Error(`Veo video download answered ${download.status}: ${await errorText(download)}`);
  return { bytes: new Uint8Array(await download.arrayBuffer()), contentType: download.headers.get("content-type") ?? "video/mp4", model };
}

export async function discoverGeminiMedia(): Promise<Array<{ kind: string; model: string; methods: string[]; description: string }>> {
  const key = geminiApiKey();
  const res = await fetch(`${BASE()}/v1beta/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
  if (!res.ok) throw new Error(`Gemini model catalog answered ${res.status}: ${await errorText(res)}`);
  const body: any = await res.json();
  const out: Array<{ kind: string; model: string; methods: string[]; description: string }> = [];
  for (const m of body.models ?? []) {
    const id = String(m.name ?? "").replace(/^models\//, "");
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
    let kind = "";
    if (/^veo-/i.test(id) && methods.includes("predictLongRunning")) kind = "video";
    else if (/^lyria-/i.test(id) && methods.includes("generateContent")) kind = "music";
    else if (/-tts-/i.test(id) && methods.includes("generateContent")) kind = "speech";
    else if (/-image(?:-|$)/i.test(id) && methods.includes("generateContent")) kind = "image";
    if (kind) out.push({ kind, model: id, methods, description: String(m.description ?? "") });
  }
  return out;
}
