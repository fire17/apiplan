// The bridge against a fake upstream: proves header injection, stream→JSON buffering,
// the string-input fix and error mapping without touching OpenAI.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "freeauth-"));
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acc_local" } })}.s`;
writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: jwt, access_token: jwt, refresh_token: "r", account_id: "acc_local" } }));
process.env.FREEAUTH_AUTH = join(dir, "auth.json");
process.env.FREEAUTH_CODEX_AUTH = "/nonexistent";

let seen: any[] = [];
const up = Bun.serve({ port: 0, async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/models") return Response.json({ models: [{ slug: "gpt-x", display_name: "X", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
  const body = await req.json();
  seen.push({ headers: Object.fromEntries(req.headers), body });
  if (body.model === "bad") return new Response(JSON.stringify({ detail: "The 'bad' model is not supported" }), { status: 400 });
  const evs = [
    { type: "response.created", response: { id: "resp_1", model: "gpt-x-2026" } },
    { type: "response.output_text.delta", delta: "pong" },
    { type: "response.completed", response: { id: "resp_1", model: "gpt-x-2026", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
process.env.FREEAUTH_UPSTREAM = `http://127.0.0.1:${up.port}`;

let bridge: any, base: string;
beforeAll(async () => { const { serve } = await import("../src/bridge.ts"); bridge = serve({ port: 0 }); base = `http://127.0.0.1:${bridge.port}`; });
afterAll(() => { bridge.stop(true); up.stop(true); });

const post = (path: string, body: any, headers: any = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("chat non-stream: local creds injected, Codex headers present, buffered JSON", async () => {
  seen = [];
  const r = await post("/v1/chat/completions", { model: "gpt-x", messages: [{ role: "user", content: "ping" }], max_tokens: 9 }, { authorization: "Bearer sk-dummy" });
  const j: any = await r.json();
  expect(j.choices[0].message.content).toBe("pong");
  expect(j.model).toBe("gpt-x-2026");
  expect(seen[0].headers.authorization).toBe(`Bearer ${jwt}`);
  expect(seen[0].headers["chatgpt-account-id"]).toBe("acc_local");
  expect(seen[0].headers.originator).toBe("codex_cli_rs");
  expect(seen[0].body.stream).toBe(true); expect(seen[0].body.max_output_tokens).toBeUndefined();
});

test("chat stream: SSE chunks end with [DONE]; CORS on", async () => {
  const r = await post("/v1/chat/completions", { model: "gpt-x", stream: true, messages: [{ role: "user", content: "ping" }] });
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  const t = await r.text();
  expect(t).toContain('"content":"pong"'); expect(t.trim().endsWith("data: [DONE]")).toBe(true);
});

test("responses: string input becomes a list; a web JWT bearer is forwarded as-is", async () => {
  seen = [];
  const web = `${b64({ alg: "none" })}.${b64({ exp: 9e9, "https://api.openai.com/auth": { chatgpt_account_id: "acc_web" } })}.s`;
  const r = await post("/v1/responses", { model: "gpt-x", input: "hi", max_output_tokens: 3 }, { authorization: `Bearer ${web}` });
  const j: any = await r.json();
  expect(j.status).toBe("completed");
  expect(seen[0].body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  expect(seen[0].headers.authorization).toBe(`Bearer ${web}`);
  expect(seen[0].headers["chatgpt-account-id"]).toBe("acc_web");
});

test("upstream 400 becomes an OpenAI-shaped error, not a crash", async () => {
  const r = await post("/v1/chat/completions", { model: "bad", messages: [{ role: "user", content: "x" }] });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error.message).toContain("not supported");
});

test("models: hidden entries dropped, OpenAI list shape", async () => {
  const j: any = await (await fetch(base + "/v1/models")).json();
  expect(j.data.map((m: any) => m.id)).toEqual(["gpt-x"]);
});

test("/session and /logout reflect the machine account", async () => {
  const s: any = await (await fetch(base + "/session")).json();
  expect(s.signedIn).toBe(true);
  expect(s.email).toBeUndefined(); // fake jwt has no email claim, but signedIn is true
  const out: any = await (await post("/logout", {})).json();
  expect(out.signedIn).toBe(false);
  const after: any = await (await fetch(base + "/session")).json();
  expect(after.signedIn).toBe(false);
});
