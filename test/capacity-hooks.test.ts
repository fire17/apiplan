// Real resident entry points, isolated in child processes: no module mocks, real credentials,
// keychain reads, vendor egress, or live daemon state. Only the provider HTTP endpoint is fake.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapacitySnapshot, CapacityWireLine } from "../src/capacity-events.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-opus-5";
const OTHER_MODEL = "claude-sonnet-5";
const PROMPT = "capacity probe: \u0000 café שלום";
const ANSWER = "capacity stays intact: \u0000 café שלום";
const RESET = "2099-01-01T00:00:00.000Z";
const RESET_HEADER = "anthropic-ratelimit-unified-reset";
const ACCESS = "AT-capacity-hook-fixture-A";
const CHAIN = "RT-capacity-hook-fixture-A";
const NEXT_ACCESS = "AT-capacity-hook-fixture-B";
const NEXT_CHAIN = "RT-capacity-hook-fixture-B";
const fingerprint = (chain: string) => createHash("sha256").update(chain).digest("hex").slice(0, 12);
// Use the public serialized tuple contract without importing resident module state here.
const capacityKey = (chain: string, model = MODEL) => JSON.stringify(["anthropic", fingerprint(chain), "unknown", model, null]);
const binary = new Uint8Array([0, 255, 195, 40, 13, 10, 128, 97, 0, 254]);
const sse = new TextEncoder().encode([
  { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: MODEL, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));

type Surface = "messages" | "chat" | "daemon";
type Reply = { status: number; headers: Record<string, string>; body: Uint8Array };

// This bootstrap uses public exports, not a copied handler. The extra loopback control server
// refreshes the real credential cache and injects a THROWING producer-state read on demand.
// The hook must swallow that throw; a swallowed filesystem write failure alone cannot prove it.
const BOOTSTRAP = `
const fs = await import("node:fs");
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
    return Promise.reject(new Error("fixture denied non-loopback fetch"));
  }
  return nativeFetch(input, init);
});
const { anthropic } = await import("./src/providers.ts");
const { defaultProducerState } = await import("./src/capacity-events.ts");
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST") return new Response("method", { status: 405 });
  if (path === "/refresh") {
    await anthropic.refreshCreds();
    return Response.json(anthropic.credFp());
  }
  if (path === "/fault") {
    Object.defineProperty(defaultProducerState.snapshot, "lines", { get() {
      fs.appendFileSync(process.env.APIPLAN_HOOK_FAULT_LOG, "throw\\n");
      throw new Error("fixture capacity producer failure");
    } });
    return new Response(null, { status: 204 });
  }
  return new Response("missing", { status: 404 });
} });
let url, token = "";
if (process.env.APIPLAN_HOOK_SURFACE === "daemon") {
  const { runDaemon } = await import("./src/engine.ts");
  void runDaemon();
  const deadline = Date.now() + 5000;
  while (!url && Date.now() < deadline) {
    try {
      const ipc = JSON.parse(fs.readFileSync(process.env.APIPLAN_HOME + "/daemon.json", "utf8"));
      const candidate = "http://127.0.0.1:" + ipc.port;
      if ((await fetch(candidate + "/health")).ok) { url = candidate; token = ipc.token; }
    } catch {}
    if (!url) await Bun.sleep(10);
  }
  if (!url) throw new Error("isolated daemon failed readiness");
} else {
  const { serve } = await import("./src/api.ts");
  url = serve({ port: 0, host: "127.0.0.1", token: "" }).url;
}
console.log("CAPACITY_READY " + JSON.stringify({ url, token, control: "http://127.0.0.1:" + control.port }));
await new Promise(() => {});
`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function ready(stdout: ReadableStream<Uint8Array>): Promise<{ url: string; token: string; control: string }> {
  const reader = stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let text = "";
        while (true) {
          const part = await reader.read();
          if (part.done) throw new Error(`resident exited before readiness: ${text}`);
          text += new TextDecoder().decode(part.value);
          const line = text.split("\n").slice(0, -1).find((row) => row.startsWith("CAPACITY_READY "));
          if (line) return JSON.parse(line.slice("CAPACITY_READY ".length));
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("resident readiness timeout")), 8000); }),
    ]);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function withResident(surface: Surface, exercise: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(surface);
  try { await exercise(f); } finally { await f.stop(); }
}

async function fixture(surface: Surface) {
  const dir = mkdtempSync(join(tmpdir(), "ap-cap-hooks-"));
  const home = join(dir, "home");
  const emptyPath = join(dir, "empty-bin");
  mkdirSync(home); mkdirSync(emptyPath);
  const credFile = join(dir, "anthropic.json");
  const faultLog = join(dir, "producer-faults.log");
  const snapshotPath = join(home, "capacity-state.json");
  const journalPath = join(home, "capacity-events.jsonl");
  const writeCredential = (access = ACCESS, chain = CHAIN) => writeFileSync(credFile, JSON.stringify({
    claudeAiOauth: { accessToken: access, refreshToken: chain, expiresAt: Date.now() + 6 * 3600_000 },
  }));
  writeCredential();
  let response: Reply;
  let hold: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const requests: Array<{ authorization: string | null; body: any; path: string }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/tags") return Response.json({ models: [] });
    if (path !== "/v1/messages" || req.method !== "POST") return new Response("unexpected fixture path", { status: 404 });
    requests.push({ authorization: req.headers.get("authorization"), body: await req.json(), path });
    const chosen = response;
    const gate = hold; hold = undefined;
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    if (!chosen) return new Response("no response configured", { status: 500 });
    // Two chunks include invalid UTF-8 on the daemon path: reading/re-encoding the body would fail.
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(chosen.body.slice(0, 3)); controller.enqueue(chosen.body.slice(3)); controller.close();
    } });
    return new Response(body, { status: chosen.status, headers: chosen.headers });
  } });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("APIPLAN_")));
  const env = {
    ...inherited,
    HOME: home, USERPROFILE: home, PATH: emptyPath,
    APIPLAN_HOME: home, APIPLAN_IPC: "tcp", APIPLAN_API_KEY: "",
    APIPLAN_ANTHROPIC_CRED_FILE: credFile,
    APIPLAN_ANTHROPIC_BASE: `http://127.0.0.1:${provider.port}`,
    APIPLAN_CODEX_AUTH: join(dir, "absent"), APIPLAN_GOOGLE_CRED_FILE: join(dir, "absent"),
    APIPLAN_OLLAMA_BASE: `http://127.0.0.1:${provider.port}`,
    APIPLAN_CAPACITY_STATE: snapshotPath, APIPLAN_CAPACITY_EVENTS: journalPath,
    APIPLAN_KEEPALIVE_MS: "0", APIPLAN_DAEMON_IDLE_MS: "60000", APIPLAN_TALK_PARK: "0",
    APIPLAN_CRED_CACHE_MS: "3600000", APIPLAN_HOOK_SURFACE: surface, APIPLAN_HOOK_FAULT_LOG: faultLog,
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  };
  const child = Bun.spawn([process.execPath, "-e", BOOTSTRAP], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const stop = async () => {
    hold?.release.resolve();
    child.kill(); await child.exited;
    provider.stop(true);
    rmSync(dir, { recursive: true, force: true });
  };
  let resident: Awaited<ReturnType<typeof ready>>;
  try { resident = await ready(child.stdout); }
  catch (error) { await stop(); throw new Error(`${error}\n${await stderr}`); }

  return {
    requests,
    snapshot: () => JSON.parse(readFileSync(snapshotPath, "utf8")) as CapacitySnapshot,
    events: () => existsSync(journalPath) ? readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CapacityWireLine) : [],
    faultCount: () => existsSync(faultLog) ? readFileSync(faultLog, "utf8").trim().split("\n").length : 0,
    hasSnapshot: () => existsSync(snapshotPath),
    writeCredential,
    async refresh() {
      const r = await fetch(resident.control + "/refresh", { method: "POST", signal: AbortSignal.timeout(3000) });
      expect(r.status).toBe(200);
      return await r.json() as { ident: string };
    },
    async breakProducer() {
      const r = await fetch(resident.control + "/fault", { method: "POST", signal: AbortSignal.timeout(3000) });
      expect(r.status).toBe(204);
    },
    holdNext() {
      const gate = { entered: deferred(), release: deferred() }; hold = gate; return gate;
    },
    async streamFault() {
      const fault = { type: "error", error: { type: "rate_limit_error", message: "fixture stream quota" } };
      const firstFrame = new TextDecoder().decode(sse).split("\n\n")[0] + "\n\n";
      response = { status: 200, headers: { "content-type": "text/event-stream", [RESET_HEADER]: RESET },
        body: new TextEncoder().encode(firstFrame + `event: error\ndata: ${JSON.stringify(fault)}\n\n`) };
      const r = await fetch(resident.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: PROMPT }], max_tokens: 100 }), signal: AbortSignal.timeout(5000) });
      expect(r.status).toBe(200);
      const frames = (await r.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      return frames.find((frame) => frame.type === "error")?.error;
    },
    async call(status: number, headers: Record<string, string> = {}, model = MODEL) {
      const ok = status >= 200 && status < 300;
      const error = { error: { type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "api_error", message: `fixture refusal ${status}` } };
      const bytes = ok ? sse : surface === "daemon" ? binary : new TextEncoder().encode(JSON.stringify(error));
      const contentType = ok ? "text/event-stream" : surface === "daemon" ? "application/octet-stream" : "application/json";
      response = { status, headers: { "content-type": contentType, ...headers }, body: bytes };
      const body = surface === "daemon"
        ? { model: { id: model, provider: "anthropic", family: "opus", version: [5], label: "fixture" }, turns: [{ role: "user", text: PROMPT, images: [{ mediaType: "image/png", base64: Buffer.from(binary).toString("base64") }] }], opts: {} }
        : { model, stream: false, messages: [{ role: "user", content: PROMPT }], max_tokens: 100 };
      const path = surface === "daemon" ? "/call" : surface === "messages" ? "/v1/messages" : "/v1/chat/completions";
      const r = await fetch(resident.url + path, { method: "POST", headers: { "content-type": "application/json", "x-apiplan-token": resident.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const received = new Uint8Array(await r.arrayBuffer());
      expect(r.status).toBe(status);
      if (surface === "daemon") {
        expect(received).toEqual(bytes);
        expect(r.headers.get("content-type")).toBe(contentType);
        expect(r.headers.get(RESET_HEADER)).toBeNull();
        expect(r.headers.get("x-retry-after") || "").toBe(headers["retry-after"] ?? "");
      } else {
        const json = JSON.parse(new TextDecoder().decode(received));
        if (ok) expect(surface === "messages" ? json.content[0].text : json.choices[0].message.content).toBe(ANSWER);
        else expect(json.error.message).toBe(error.error.message);
      }
      const upstream = requests.at(-1)!;
      expect(upstream.body.model).toBe(model);
      expect(upstream.body.stream).toBe(true);
      const content = upstream.body.messages[0].content;
      expect(typeof content === "string" ? content : content[0].text).toBe(PROMPT);
      if (surface === "daemon") expect(Buffer.from(upstream.body.messages[0].content[1].source.data, "base64")).toEqual(Buffer.from(binary));
      return r;
    },
    stop,
  };
}

for (const surface of ["messages", "chat", "daemon"] as const) {
  describe(`${surface}: real resident capacity hook`, () => {
    test("first 200 is a baseline; only 429 → 200 reopens, never 401/500 or repeated success", async () => {
      await withResident(surface, async (f) => {
        const key = capacityKey(CHAIN);
        await f.call(200, { [RESET_HEADER]: RESET });
        expect(f.snapshot().lines[key]).toMatchObject({ provider: "anthropic", account: fingerprint(CHAIN), model: MODEL, scope: "unknown", state: "open" });
        expect(f.snapshot().lines[key].resetsAt).toBeUndefined();
        expect(f.events()).toEqual([]);
        await f.call(429, { [RESET_HEADER]: RESET, "retry-after": "17" });
        const exhausted = f.snapshot().lines[key];
        expect(exhausted).toMatchObject({ state: "exhausted", model: MODEL, scope: "unknown", source: RESET_HEADER, resetsAt: Date.parse(RESET) });
        expect(f.events()).toEqual([]);
        for (const status of [401, 500]) {
          await f.call(status, { [RESET_HEADER]: "2099-02-01T00:00:00.000Z" });
          expect(f.snapshot().lines[key]).toEqual(exhausted);
          expect(f.events()).toEqual([]);
        }
        await f.call(200);
        expect(f.snapshot().lines[key]).toMatchObject({ state: "open", model: MODEL, scope: "unknown" });
        expect(f.snapshot().lines[key].resetsAt).toBeUndefined();
        expect(f.events()).toHaveLength(1);
        expect(f.events()[0]).toMatchObject({ v: 1, seq: 1, scope: "unknown", signal: { kind: "window-reset", provider: "anthropic", accountFingerprint: fingerprint(CHAIN) } });
        expect(f.events()[0].signal.at).toBe(f.snapshot().lines[key].observedAt);
        await f.call(200);
        expect(f.events()).toHaveLength(1);
        expect(f.requests).toHaveLength(6);
        expect(f.requests.every((r) => r.authorization === `Bearer ${ACCESS}`)).toBe(true);
        const durable = JSON.stringify({ snapshot: f.snapshot(), events: f.events() });
        expect(durable).not.toContain(ACCESS); expect(durable).not.toContain(CHAIN);
      });
    }, 15000);

    test("a retry-after-only refusal and a headerless billing refusal remain honest", async () => {
      await withResident(surface, async (f) => {
        const key = capacityKey(CHAIN);
        await f.call(429, { "retry-after": "17" });
        const limited = f.snapshot().lines[key];
        expect(limited.state).toBe("exhausted");
        expect(limited.source).toBe("retry-after");
        expect(limited.resetsAt).toBe(limited.observedAt + 17000);
        await f.call(402);
        expect(f.snapshot().lines[key]).toMatchObject({ state: "exhausted", scope: "unknown", model: MODEL });
        expect(f.snapshot().lines[key].resetsAt).toBeUndefined();
        expect(f.events()).toEqual([]);
        expect(f.requests).toHaveLength(2);
      });
    }, 15000);

    test("acceptance on a different model cannot reopen the exhausted model", async () => {
      await withResident(surface, async (f) => {
        await f.call(429, { [RESET_HEADER]: RESET });
        const exhausted = f.snapshot().lines[capacityKey(CHAIN)];
        await f.call(200, {}, OTHER_MODEL);
        expect(f.snapshot().lines[capacityKey(CHAIN)]).toEqual(exhausted);
        expect(f.snapshot().lines[capacityKey(CHAIN)]).toMatchObject({ model: MODEL, scope: "unknown", state: "exhausted", resetsAt: Date.parse(RESET) });
        expect(f.snapshot().lines[capacityKey(CHAIN, OTHER_MODEL)]).toMatchObject({ model: OTHER_MODEL, scope: "unknown", state: "open" });
        expect(f.events()).toEqual([]);
      });
    }, 15000);

    test("a credential swap in flight cannot relabel the response or the daemon's cached bearer", async () => {
      await withResident(surface, async (f) => {
        const held = f.holdNext();
        const pending = f.call(429, { [RESET_HEADER]: RESET });
        try {
          await Promise.race([held.entered.promise, pending.then(() => { throw new Error("upstream hold was not reached"); })]);
          f.writeCredential(NEXT_ACCESS, NEXT_CHAIN);
          expect((await f.refresh()).ident).toBe(fingerprint(NEXT_CHAIN));
        } finally { held.release.resolve(); }
        const refused = await pending;
        if (surface !== "daemon") {
          const metadata = JSON.parse(refused.headers.get("x-apiplan-failure")!);
          expect(metadata).toMatchObject({ v: 1, provider: "anthropic", accountFingerprint: fingerprint(CHAIN), model: MODEL,
            scope: "unknown", status: 429, errorType: "rate_limit_error", resetAt: Date.parse(RESET) });
          expect(metadata.accountFingerprint).not.toBe(fingerprint(NEXT_CHAIN));
          expect(refused.headers.get("x-apiplan-failure")).not.toContain(ACCESS);
          expect(refused.headers.get("x-apiplan-failure")).not.toContain(CHAIN);
        }
        const oldKey = capacityKey(CHAIN);
        const newKey = capacityKey(NEXT_CHAIN);
        expect(f.snapshot().lines[oldKey]).toMatchObject({ state: "exhausted", model: MODEL, scope: "unknown" });
        expect(f.snapshot().lines[newKey]).toBeUndefined();
        expect(f.requests[0].authorization).toBe(`Bearer ${ACCESS}`);
        await f.call(200);
        if (surface === "daemon") {
          expect(f.requests[1].authorization).toBe(`Bearer ${ACCESS}`);
          expect(f.snapshot().lines[oldKey].state).toBe("open");
          expect(f.snapshot().lines[newKey]).toBeUndefined();
          expect(f.events()).toHaveLength(1);
          expect(f.events()[0].signal.accountFingerprint).toBe(fingerprint(CHAIN));
        } else {
          expect(f.requests[1].authorization).toBe(`Bearer ${NEXT_ACCESS}`);
          expect(f.snapshot().lines[oldKey].state).toBe("exhausted");
          expect(f.snapshot().lines[newKey]).toMatchObject({ state: "open", model: MODEL, scope: "unknown" });
          expect(f.events()).toEqual([]);
        }
      });
    }, 15000);

    test("recordCapacity throwing cannot replace the upstream status or consume its body", async () => {
      await withResident(surface, async (f) => {
        await f.breakProducer();
        await f.call(429, { [RESET_HEADER]: RESET });
        await f.call(200);
        expect(f.faultCount()).toBe(2);
        expect(f.hasSnapshot()).toBe(false);
        expect(f.events()).toEqual([]);
        expect(f.requests).toHaveLength(2);
      });
    }, 15000);
  });
}

test("late SSE failure carries the same request attribution as HTTP failure", async () => {
  await withResident("messages", async (f) => {
    const error = await f.streamFault();
    expect(error).toMatchObject({ type: "rate_limit_error", x_apiplan_failure: { v: 1, provider: "anthropic",
      accountFingerprint: fingerprint(CHAIN), model: MODEL, scope: "unknown", status: 429, resetAt: Date.parse(RESET) } });
    expect(JSON.stringify(error)).not.toContain(ACCESS);
    expect(JSON.stringify(error)).not.toContain(CHAIN);
  });
}, 15000);
