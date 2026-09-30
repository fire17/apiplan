/**
 * midsystem-gateway-capability.ts — what the GATEWAY actually does with a mid-conversation
 * operator turn, per backend, observed on the wire rather than reasoned about.
 *
 * The catalog's `compat.supportsMidConversationSystem` describes what THIS GATEWAY accepts and
 * forwards, not what api.anthropic.com accepts. A harness reads it to decide whether to send the
 * operator instruction as a wire `system` message at all: when it is false the harness demotes the
 * turn to `role:"user"` BEFORE the request leaves, so the gateway never sees `isSystem` and cannot
 * map it to anything. Every gateway-capable backend must therefore opt in, or the capability is lost
 * upstream of the gateway.
 *
 * This probe sends an Anthropic-dialect request carrying a mid-conversation `role:"system"` message
 * to a real `serve()` and captures the OUTBOUND body a fake loopback upstream receives, for one model
 * per backend. No vendor is reached and no credential is used beyond a synthetic file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ap-midsystem-"));
const anthropicCred = join(dir, "anthropic.json");
writeFileSync(anthropicCred, JSON.stringify({
  claudeAiOauth: { accessToken: "AT-midsystem-fixture", refreshToken: "RT-midsystem-fixture", expiresAt: Date.now() + 6 * 3600_000 },
}));
const codexCred = join(dir, "codex.json");
writeFileSync(codexCred, JSON.stringify({
  tokens: { access_token: "AT-codex-fixture", refresh_token: "RT-codex-fixture", account_id: "acct-fixture" },
  account_id: "acct-fixture",
}));
const geminiCred = join(dir, "google.json");
writeFileSync(geminiCred, JSON.stringify({ access_token: "AT-google-fixture", account: "acct-google", expiry: Date.now() + 6 * 3600_000 }));

const captured: Array<{ path: string; body: unknown }> = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/tags") return Response.json({ models: [] });
    captured.push({ path, body: await req.json() });
    // A minimal but valid Anthropic SSE stream; the openai/gemini paths only need the request
    // captured, and an unparseable stream would still not undo the capture.
    const frames = [
      { type: "message_start", message: { id: "fx", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});
const base = `http://127.0.0.1:${upstream.port}`;

process.env.APIPLAN_HOME = dir;
process.env.APIPLAN_API_KEY = "";
process.env.APIPLAN_ANTHROPIC_CRED_FILE = anthropicCred;
process.env.APIPLAN_CODEX_AUTH = codexCred;
process.env.APIPLAN_GOOGLE_CRED_FILE = geminiCred;
process.env.APIPLAN_ANTHROPIC_BASE = base;
process.env.APIPLAN_OPENAI_BASE = base;
process.env.APIPLAN_GOOGLE_BASE = base;
process.env.APIPLAN_OLLAMA_BASE = base;
process.env.APIPLAN_CAPACITY_STATE = join(dir, "capacity-state.json");
process.env.APIPLAN_CAPACITY_EVENTS = join(dir, "capacity-events.jsonl");

const report: Record<string, unknown> = { probe: "midsystem-gateway-capability", at: new Date().toISOString(), upstream: base };

try {
  // Dynamic on purpose, and it cannot be static: these modules read APIPLAN_* at import time
  // (STATE_DIR, credential paths, provider base URLs), so they must be loaded AFTER the env
  // above is set. A static import is hoisted and would bind the real ~/.apiplan instead.
  const { serve } = await import("../../src/api.ts");
  const { MIDCONV_SYSTEM } = await import("../../src/providers.ts");
  const { models } = await import("../../src/registry.ts");
  const server = serve({ port: 0, host: "127.0.0.1", token: "" });
  const registry = models();
  const providerOf = (id: string) => registry.find(m => m.id === id)?.provider ?? "unknown";

  const rows: Array<Record<string, unknown>> = [];
  for (const model of ["claude-opus-5", "claude-opus-4-6", "gpt-6-astra", "gpt-5.6-sol", "gemini-3.1-pro"]) {
    captured.length = 0;
    // The Anthropic dialect, carrying a MID-CONVERSATION system message: user, system, then a
    // request for the assistant. This is exactly the shape a harness sends when the compat flag
    // is on; when it is off the harness sends role:"user" here and nothing below can recover it.
    const res = await fetch(`${server.url}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 8, stream: false,
        system: "lead prompt",
        messages: [
          { role: "user", content: "first" },
          { role: "system", content: "OPERATOR: mid-conversation instruction" },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    await res.text();
    const sent = captured.at(-1)?.body as Record<string, unknown> | undefined;
    // Anthropic sends `messages`; the Responses API sends `input`; Gemini sends `contents`.
    const wire = (sent?.messages ?? sent?.input ?? sent?.contents) as Array<Record<string, unknown>> | undefined;
    const roles = (wire ?? []).map(item => String(item.role ?? "?"));
    const operatorText = "OPERATOR: mid-conversation instruction";
    const index = (wire ?? []).findIndex(item => JSON.stringify(item).includes(operatorText));
    rows.push({
      model,
      registryProvider: providerOf(model),
      anthropicMidconvPredicate: MIDCONV_SYSTEM(model),
      status: res.status,
      outboundPath: captured.at(-1)?.path,
      outboundRoles: roles,
      operatorTurnIndex: index,
      operatorTurnRole: index >= 0 ? roles[index] : null,
      // The two things that matter: the role it travelled as, and that it stayed IN POSITION
      // (after the user turn, not hoisted to the front and not dropped).
      positionPreserved: index === 1,
      carriesDistinctOperatorRole: index >= 0 && roles[index] !== "user" && roles[index] !== "model",
    });
  }
  report.rows = rows;
  report.verdict = {
    gatewayAcceptsMidSystemForEveryModel: rows.every(r => (r.operatorTurnIndex as number) >= 0),
    backendsCarryingADistinctOperatorRole: rows.filter(r => r.carriesDistinctOperatorRole).map(r => `${r.registryProvider}/${r.model}`),
    backendsDemotingToUserInPosition: rows.filter(r => !r.carriesDistinctOperatorRole).map(r => `${r.registryProvider}/${r.model}`),
  };
  server.stop();
  report.status = "passed";
} catch (error: unknown) {
  report.status = "failed";
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  upstream.stop(true);
  console.log(JSON.stringify(report, null, 2));
  rmSync(dir, { recursive: true, force: true });
}
