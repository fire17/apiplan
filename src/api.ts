// api.ts — a local server that speaks OpenAI's and Anthropic's wire shapes, so any
// SDK, agent framework or app can point its base URL at localhost and be answered by
// the subscriptions already logged in on this machine.
//
// The endpoint dialect and the backend are deliberately independent: which SHAPE you
// get is decided by the path you call, which MODEL answers is decided by the `model`
// field. So `/v1/chat/completions` with `model: "opus"` gives you Claude in OpenAI's
// shape — which is the whole point, since most tooling only speaks one dialect.
import { PROVIDERS, providerFor, speakRealtime, type Delta, type ImageRef, type Turn, type CallOpts } from "./providers.ts";
import { models, resolve, type Model } from "./registry.ts";

const now = () => Math.floor(Date.now() / 1000);
const rid = (p: string) => `${p}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

// ─────────────────────────── talking to a provider ───────────────────────────

/** One call, normalised to our own Delta events. The CLI's consume() can't be reused: it
 *  writes to stdout and calls die(), which would take the server down with it. */
async function* run(m: Model, turns: Turn[], o: CallOpts): AsyncGenerator<Delta> {
  const p = providerFor(m);
  const { url, headers, body } = p.build(m, turns, o, p.creds());
  // Always stream upstream, exactly as callDirect does — build() leaves `stream` to the
  // caller, and Anthropic answers a plain JSON body without it, which the SSE reader
  // below would then read as zero events (an empty, silent reply).
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
  if (!res.ok || !res.body) {
    let detail = (await res.text()).slice(0, 500);
    try { const j = JSON.parse(detail); detail = j?.error?.message || j?.detail || detail; } catch {}
    throw new HttpError(res.status, detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue }
      const d = p.delta(ev);
      if (d.error) throw new HttpError(502, d.error);
      if (d.text || d.reasoning || d.served || d.imageB64) yield d;
    }
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Resolve the caller's model name, or say exactly what we do have. */
function pick(name: unknown): Model {
  if (typeof name !== "string" || !name) throw new HttpError(400, "`model` is required");
  const m = resolve(name);
  if (!m) throw new HttpError(404, `unknown model '${name}'. Try: ${models().slice(0, 8).map((x) => x.id).join(", ")} (GET /v1/models for all)`);
  return m;
}

// ─────────────────────────── request → our Turn[] ───────────────────────────

/** Both dialects allow a bare string or a content-part array; images differ in shape. */
function partsToTurn(role: "user" | "assistant", content: any): Turn {
  if (typeof content === "string") return { role, text: content };
  const images: ImageRef[] = [];
  let text = "";
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "text" && typeof part.text === "string") text += (text ? "\n" : "") + part.text;
    // OpenAI: {type:"image_url", image_url:{url}} — url may be http(s) or a data: URI
    else if (part?.type === "image_url") {
      const u = part.image_url?.url ?? part.image_url;
      if (typeof u === "string") images.push(dataUriOrUrl(u));
    }
    // Anthropic: {type:"image", source:{type:"base64"|"url", ...}}
    else if (part?.type === "image" && part.source) {
      const s = part.source;
      if (s.type === "url" && s.url) images.push({ url: s.url });
      else if (s.data) images.push({ mediaType: s.media_type ?? "image/png", base64: s.data });
    }
  }
  return { role, text, ...(images.length ? { images } : {}) };
}
const dataUriOrUrl = (u: string): ImageRef => {
  const m = u.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mediaType: m[1], base64: m[2] } : { url: u };
};

/** OpenAI puts system turns in `messages`; we carry them separately, as Anthropic does. */
function fromOpenAI(body: any): { turns: Turn[]; system?: string } {
  const turns: Turn[] = [];
  let system = "";
  for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
    if (msg?.role === "system" || msg?.role === "developer") {
      const t = typeof msg.content === "string" ? msg.content : partsToTurn("user", msg.content).text;
      system += (system ? "\n\n" : "") + t;
    } else if (msg?.role === "user" || msg?.role === "assistant") {
      turns.push(partsToTurn(msg.role, msg.content));
    }
  }
  if (!turns.length) throw new HttpError(400, "`messages` must contain at least one user or assistant message");
  return { turns, ...(system ? { system } : {}) };
}

function fromAnthropic(body: any): { turns: Turn[]; system?: string } {
  const turns: Turn[] = [];
  for (const msg of Array.isArray(body?.messages) ? body.messages : []) {
    if (msg?.role === "user" || msg?.role === "assistant") turns.push(partsToTurn(msg.role, msg.content));
  }
  if (!turns.length) throw new HttpError(400, "`messages` must contain at least one message");
  const sys = body?.system;
  const system = typeof sys === "string" ? sys
    : Array.isArray(sys) ? sys.map((s: any) => s?.text ?? "").filter(Boolean).join("\n\n")
    : undefined;
  return { turns, ...(system ? { system } : {}) };
}

/** Shared knobs. Effort is accepted under either vendor's spelling. */
function optsFrom(body: any, system?: string): CallOpts {
  const o: CallOpts = {};
  if (system) o.system = system;
  const effort = body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.thinking?.effort ?? body?.output_config?.effort;
  if (typeof effort === "string") o.effort = effort;
  const max = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  if (typeof max === "number") o.maxTokens = max;
  if (typeof body?.temperature === "number") o.temperature = body.temperature;
  if (body?.thinking?.type === "disabled") o.thinkOff = true;
  return o;
}

// ─────────────────────────── our Deltas → each dialect ───────────────────────────

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

function streamResponse(gen: () => AsyncGenerator<string>): Response {
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      try { for await (const chunk of gen()) c.enqueue(enc.encode(chunk)); }
      catch (e: any) {
        // Mid-stream failure: the status is already sent, so the error has to ride the
        // stream. Both SDKs surface a data: frame carrying an `error` object.
        c.enqueue(enc.encode(sse({ error: { message: e?.message ?? String(e), type: "upstream_error" } })));
      }
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

async function openaiChat(body: any): Promise<Response> {
  const m = pick(body?.model);
  const { turns, system } = fromOpenAI(body);
  const o = optsFrom(body, system);
  const id = rid("chatcmpl"), created = now();

  if (!body?.stream) {
    let text = "";
    for await (const d of run(m, turns, o)) text += d.text ?? "";
    return json({
      id, object: "chat.completion", created, model: m.id,
      choices: [{ index: 0, message: { role: "assistant", content: text }, logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  return streamResponse(async function* () {
    const head = { id, object: "chat.completion.chunk", created, model: m.id };
    yield sse({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for await (const d of run(m, turns, o)) {
      if (d.text) yield sse({ ...head, choices: [{ index: 0, delta: { content: d.text }, finish_reason: null }] });
    }
    yield sse({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    yield "data: [DONE]\n\n";
  });
}

async function anthropicMessages(body: any): Promise<Response> {
  const m = pick(body?.model);
  const { turns, system } = fromAnthropic(body);
  const o = optsFrom(body, system);
  const id = rid("msg");

  if (!body?.stream) {
    let text = "";
    for await (const d of run(m, turns, o)) text += d.text ?? "";
    return json({
      id, type: "message", role: "assistant", model: m.id,
      content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }
  return streamResponse(async function* () {
    const msg = { id, type: "message", role: "assistant", model: m.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    yield sse({ type: "message_start", message: msg }, "message_start");
    yield sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
    for await (const d of run(m, turns, o)) {
      if (d.text) yield sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d.text } }, "content_block_delta");
    }
    yield sse({ type: "content_block_stop", index: 0 }, "content_block_stop");
    yield sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } }, "message_delta");
    yield sse({ type: "message_stop" }, "message_stop");
  });
}

/** Both vendors serve GET /v1/models; the shapes differ, so answer by dialect. */
function listModels(dialect: "openai" | "anthropic"): Response {
  const all = models();
  if (dialect === "anthropic") {
    return json({ data: all.map((m) => ({ type: "model", id: m.id, display_name: m.label, created_at: new Date(0).toISOString() })), has_more: false, first_id: all[0]?.id ?? null, last_id: all.at(-1)?.id ?? null });
  }
  return json({ object: "list", data: all.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider })) });
}

async function speech(body: any): Promise<Response> {
  const text = body?.input;
  if (typeof text !== "string" || !text) throw new HttpError(400, "`input` is required");
  const voice = typeof body?.voice === "string" ? body.voice : "alloy";
  // `instructions` is OpenAI's own field for steering delivery — same idea as `tts --as`.
  const direction = typeof body?.instructions === "string" ? body.instructions : undefined;
  const { bytes, contentType } = await speakRealtime(PROVIDERS.openai.creds(), { text, voice, format: "wav", direction });
  return new Response(bytes, { headers: { "content-type": contentType } });
}

async function images(body: any): Promise<Response> {
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt) throw new HttpError(400, "`prompt` is required");
  const m = resolve(body?.model && String(body.model).startsWith("gpt") ? body.model : "sol");
  if (!m) throw new HttpError(404, "no OpenAI model available to draw with");
  const o: CallOpts = { genImage: true, ...(body?.size ? { imageSize: body.size } : {}), ...(body?.quality ? { imageQuality: body.quality } : {}) };
  let b64 = "", revised = "";
  for await (const d of run(m, [{ role: "user", text: prompt }], o)) {
    if (d.imageB64) b64 = d.imageB64;
    if (d.revisedPrompt) revised = d.revisedPrompt;
  }
  if (!b64) throw new HttpError(502, "the model returned no image");
  return json({ created: now(), data: [{ b64_json: b64, ...(revised ? { revised_prompt: revised } : {}) }] });
}

// ─────────────────────────── the server ───────────────────────────

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Error bodies must match the dialect too, or the SDKs won't parse them. */
function errorFor(dialect: "openai" | "anthropic", status: number, message: string): Response {
  return dialect === "anthropic"
    ? json({ type: "error", error: { type: status === 404 ? "not_found_error" : status === 400 ? "invalid_request_error" : "api_error", message } }, status)
    : json({ error: { message, type: status === 404 ? "invalid_request_error" : "invalid_request_error", param: null, code: null } }, status);
}

export type ServeOpts = { port?: number; host?: string; token?: string };

export function serve(opts: ServeOpts = {}) {
  const port = opts.port ?? Number(process.env.APIPLAN_API_PORT ?? 8787);
  // Bind loopback by default: this hands out your subscription to whoever can reach it.
  const hostname = opts.host ?? process.env.APIPLAN_API_HOST ?? "127.0.0.1";
  const token = opts.token ?? process.env.APIPLAN_API_KEY;

  const server = Bun.serve({
    port, hostname,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const dialect: "openai" | "anthropic" = path.includes("/messages") || req.headers.has("x-api-key") ? "anthropic" : "openai";
      try {
        // A token is optional (it is loopback), but when set it is enforced on both the
        // OpenAI and the Anthropic auth headers, since callers use whichever they know.
        if (token) {
          const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
          if (bearer !== token && req.headers.get("x-api-key") !== token) throw new HttpError(401, "invalid api key");
        }
        if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return listModels(dialect);
        if (req.method === "GET" && (path === "/health" || path === "/")) {
          return json({ ok: true, service: "apiplan", models: models().length, dialects: ["openai", "anthropic"] });
        }
        if (req.method !== "POST") throw new HttpError(405, `${req.method} ${path} is not supported`);

        let body: any;
        try { body = await req.json(); } catch { throw new HttpError(400, "body must be JSON") }

        switch (path) {
          case "/v1/chat/completions": case "/chat/completions": return await openaiChat(body);
          case "/v1/messages": case "/messages": return await anthropicMessages(body);
          case "/v1/audio/speech": case "/audio/speech": return await speech(body);
          case "/v1/images/generations": case "/images/generations": return await images(body);
          default: throw new HttpError(404, `no route for POST ${path}`);
        }
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        return errorFor(dialect, status, e?.message ?? String(e));
      }
    },
  });
  // server.port, not the requested one: port 0 means "any free port", and only the
  // server knows which it got.
  return { url: `http://${hostname}:${server.port}`, port: server.port, hostname, tokenRequired: !!token, stop: () => server.stop(true) };
}
