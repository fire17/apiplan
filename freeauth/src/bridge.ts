// bridge.ts — a local server that looks like api.openai.com (Responses + Chat Completions
// + models) and answers from the ChatGPT subscription via Codex's internal endpoint.
// It injects the headers Codex sends, always streams upstream (the endpoint accepts
// nothing else) and buffers into a plain JSON reply when the caller did not ask to stream.
import { accessToken, load, save } from "./store.ts";
import { accountId, claims, login, ORIGINATOR } from "./oauth.ts";
import { chatToResponses, chunker, foldChat } from "./convert.ts";

const UPSTREAM = process.env.FREEAUTH_UPSTREAM ?? "https://chatgpt.com/backend-api/codex";
const CLIENT_VERSION = process.env.FREEAUTH_CLIENT_VERSION ?? "0.146.0";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, chatgpt-account-id, x-freeauth-key" };

let loginInFlight: Promise<any> | null = null;
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...CORS } });
const isJwt = (s?: string | null) => !!s && s.split(".").length === 3;

/**
 * Who is calling: a bearer that is a real JWT (the web SDK, whose user signed in through
 * the extension) is forwarded as-is; anything else — no header, "freeauth", a dummy
 * key an SDK insists on sending — means "use the account signed in on this machine".
 */
async function credentials(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (isJwt(bearer)) return { token: bearer!, account: req.headers.get("chatgpt-account-id") ?? accountId({ access_token: bearer!, id_token: "" }) };
  const c = await accessToken();
  return { token: c.token, account: c.account };
}

async function upstream(req: Request, path: string, init: RequestInit) {
  const c = await credentials(req);
  const res = await fetch(`${UPSTREAM}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${c.token}`, "chatgpt-account-id": c.account ?? "", originator: ORIGINATOR,
      session_id: crypto.randomUUID(), "content-type": "application/json", accept: "text/event-stream", ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = (await res.text()).slice(0, 600);
    try { const j = JSON.parse(detail); detail = j?.error?.message ?? j?.detail ?? detail; } catch {}
    throw new HttpError(res.status, detail);
  }
  return res;
}

/** POST a Responses body upstream (stream forced on) and yield its parsed SSE events. */
async function* events(req: Request, body: any): AsyncGenerator<any> {
  const { max_output_tokens: _drop, ...rest } = body; // rejected by the backend with a 400
  if (typeof rest.input === "string") rest.input = [{ role: "user", content: [{ type: "input_text", text: rest.input }] }]; // "Input must be a list"
  const res = await upstream(req, "/responses", { method: "POST", body: JSON.stringify({ ...rest, store: false, stream: true }) });
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(p); } catch { continue; }
      if (ev.type === "response.failed") throw new HttpError(502, ev.response?.error?.message ?? "response failed");
      if (ev.type === "error" || ev.type === "response.error") throw new HttpError(502, ev.error?.message ?? ev.message ?? "stream error");
      yield ev;
    }
  }
}

const sse = (gen: AsyncGenerator<string>) => new Response(new ReadableStream({
  async pull(ctl) {
    try { const { done, value } = await gen.next(); if (done) ctl.close(); else ctl.enqueue(new TextEncoder().encode(value)); }
    catch (e: any) { ctl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`)); ctl.close(); }
  },
}), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });

async function responses(req: Request, body: any) {
  if (body.stream) return sse((async function* () { for await (const ev of events(req, body)) yield `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`; })());
  let final: any = null;
  for await (const ev of events(req, body)) if (ev.type === "response.completed" || ev.type === "response.incomplete") final = ev.response;
  if (!final) throw new HttpError(502, "stream ended without a completed response");
  return json(final);
}

async function chat(req: Request, body: any) {
  if (!Array.isArray(body.messages)) throw new HttpError(400, "messages must be an array");
  const c = chunker(`chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, body.model, Math.floor(Date.now() / 1000));
  const src = events(req, chatToResponses(body));
  if (body.stream) return sse((async function* () {
    for await (const ev of src) for (const ch of c.feed(ev)) yield `data: ${JSON.stringify(ch)}\n\n`;
    yield "data: [DONE]\n\n";
  })());
  const chunks: any[] = [];
  for await (const ev of src) chunks.push(...c.feed(ev));
  return json(foldChat(chunks));
}

async function models(req: Request) {
  const res = await upstream(req, `/models?client_version=${CLIENT_VERSION}`, { method: "GET", headers: { accept: "application/json" } });
  const j: any = await res.json();
  const list = (j.models ?? []).filter((m: any) => m.visibility !== "hide");
  return json({ object: "list", data: list.map((m: any) => ({ id: m.slug, object: "model", created: 0, owned_by: "openai", display_name: m.display_name, reasoning_efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e.effort) })) });
}

export function serve(opts: { port?: number; webDir?: string } = {}) {
  const port = opts.port ?? Number(process.env.FREEAUTH_PORT ?? 1456);
  return Bun.serve({
    port, hostname: process.env.FREEAUTH_HOST ?? "127.0.0.1", idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      try {
        if (req.method === "GET" && path === "/health") return json({ ok: true, service: "freeauth" });
        // Who is signed in ON THIS MACHINE (no extension, no in-page OAuth needed).
        if (req.method === "GET" && path === "/session") {
          const cur = load();
          if (!cur) return json({ signedIn: false });
          const c = claims(cur.tokens.id_token);
          return json({ signedIn: true, email: c.email, plan: c["https://api.openai.com/auth"]?.chatgpt_plan_type, source: cur.source });
        }
        // Run the localhost:1455 sign-in from the bridge itself — the bridge is local, so
        // it can be the callback catcher the browser page cannot be. Opens your browser once.
        if (req.method === "POST" && path === "/login") {
          if (!loginInFlight) loginInFlight = login().then((t) => { save(t); return t; }).finally(() => { loginInFlight = null; });
          const t = await loginInFlight;
          const c = claims(t.id_token);
          return json({ signedIn: true, email: c.email, plan: c["https://api.openai.com/auth"]?.chatgpt_plan_type });
        }
        if (req.method === "POST" && path === "/logout") { const { clear } = await import("./store.ts"); clear(); return json({ signedIn: false }); }
        if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return await models(req);
        if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) return await responses(req, await req.json());
        if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) return await chat(req, await req.json());
        if (req.method === "GET" && opts.webDir) { // the demo page + SDK, same origin as the API
          const f = Bun.file(`${opts.webDir}${path === "/" ? "/index.html" : path}`);
          if (await f.exists()) return new Response(f, { headers: CORS });
        }
        throw new HttpError(404, `${req.method} ${path} is not served here`);
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500;
        return json({ error: { message: e?.message ?? String(e), type: status === 401 ? "authentication_error" : "invalid_request_error" } }, status);
      }
    },
  });
}
