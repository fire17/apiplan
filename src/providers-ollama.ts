// providers-ollama.ts — the LOCAL vendor.
//
// Every other provider here is a subscription behind an OAuth token; ollama is a daemon
// on this machine. So "logged in" means "the daemon answers", the model list is whatever
// has been pulled, and the token counts come back EXACT instead of estimated.
//
// Why a provider rather than "just run `ollama run heretic`": apiplan is the one place a
// name is resolved, an effort is chosen, a request is built and a stream is read. A local
// model living outside it is a second namespace with its own aliases, its own doctor, and
// no route into anything that consumes apiplan — the api server, the commands on PATH, the
// warm daemon. Inside it, `heretic` is a model exactly the way `opus` is.
//
// TWO WIRE SHAPES, ONE PROVIDER (both measured live on this rig, 2026-08-27):
//   NATIVE  POST /api/chat             NDJSON — one JSON object per line, no `data:` prefix.
//                                      Carries message.thinking separately, tool_calls whose
//                                      `arguments` is a real OBJECT, and on the final line
//                                      prompt_eval_count / eval_count — the true counts.
//   COMPAT  POST /v1/chat/completions  ollama's OpenAI-shaped endpoint: real SSE `data:`
//                                      lines, usage on the last chunk when the caller asks
//                                      with stream_options.include_usage.
// NATIVE is the default: it is the only one that reports thinking apart from the answer and
// the only one that never re-encodes tool arguments through a string. COMPAT is the escape
// hatch — an engine that has not learned NDJSON framing still reads it, so
// `APIPLAN_OLLAMA_WIRE=compat` makes this provider work with no other change anywhere.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { STATE_DIR, writeJson } from "./platform.ts";
import { saveModels } from "./registry.ts";
import type { Model } from "./registry.ts";
import type { Provider, Turn, CallOpts, Creds, Built, Delta, ToolDef } from "./providers.ts";
import type { StreamShape } from "./stream-shape.ts";

const env = (k: string, d: string) => (process.env[k]?.length ? process.env[k]! : d);

export const OLLAMA_BASE = () => env("APIPLAN_OLLAMA_BASE", env("OLLAMA_HOST", "http://127.0.0.1:11434")).replace(/\/+$/, "");
const WIRE = () => (env("APIPLAN_OLLAMA_WIRE", "native") === "compat" ? "compat" : "native");
/** How long the daemon keeps the weights resident after a call. Empty = ollama's own default. */
const KEEP_ALIVE = () => process.env.APIPLAN_OLLAMA_KEEP_ALIVE ?? "";
/** A ceiling on the context we ask for, because num_ctx is what allocates the KV cache:
 *  asking a 30B model for its full 262144 window can be more memory than the machine has. */
const CTX_CAP = () => Number(env("APIPLAN_OLLAMA_MAX_CTX", "65536")) || 65536;

// ── the metadata sidecar ──────────────────────────────────────────────────────
/**
 * `apiplan models --refresh` writes what /api/show reports for each local model — its
 * context length and its capabilities — next to the model cache. build() reads it because
 * two of those facts change the REQUEST:
 *   · num_ctx — ollama defaults a request to 4096 tokens of context and silently truncates
 *     the rest. A 40k-token agent prompt answered from its last 4k is the worst failure
 *     mode there is: confident, fluent, and about the wrong text. This is the fix.
 *   · capabilities — a model without `tools` answers 400 when tools are sent, and one
 *     without `thinking` answers 400 when `think` is sent. Ask only for what it has.
 * A missing sidecar is not an error: every field falls back to "unknown", which means
 * "send nothing extra" — the same request the ollama CLI itself would make.
 */
export type OllamaMeta = { ctx?: number; capabilities?: string[] };
export const OLLAMA_META_FILE = () => join(STATE_DIR, "models.ollama.meta.json");
let metaCache: { at: number; data: Record<string, OllamaMeta> } | null = null;
export function ollamaMeta(): Record<string, OllamaMeta> {
  if (metaCache && Date.now() - metaCache.at < 5000) return metaCache.data;
  let data: Record<string, OllamaMeta> = {};
  try {
    const f = OLLAMA_META_FILE();
    if (existsSync(f)) data = JSON.parse(readFileSync(f, "utf8"))?.models ?? {};
  } catch { data = {}; }
  metaCache = { at: Date.now(), data };
  return data;
}
const capable = (id: string, cap: string) => (ollamaMeta()[id]?.capabilities ?? []).includes(cap);

// ── the daemon probe ──────────────────────────────────────────────────────────
/**
 * probe() is synchronous by contract (status, models and doctor all call it inline), so the
 * reachability check runs through `curl` the way the Keychain reads run through `security`.
 * One second is a generous ceiling for a loopback GET; a slower answer means "not usable
 * for a call", which is what the caller is really asking.
 */
/**
 * F9-2: and it is a spawnSync, so a resident host pays it on EVERY /health — measured 7.2 ms
 * per probe, which is the tail of the staircase the credential caches removed. Cached for a
 * few seconds, exactly like ollamaMeta above it: a burst of ten parallel requests costs one
 * probe, and a daemon that dies is still noticed within the window.
 */
const PROBE_CACHE_MS = () => Number(env("APIPLAN_OLLAMA_PROBE_CACHE_MS", "3000")) || 3000;
// Keyed on the BASE: a caller that re-points APIPLAN_OLLAMA_BASE is asking about a
// different daemon, and answering that from a cache of the previous one would be a lie.
let verCache: { at: number; base: string; v: { ok: boolean; detail: string } } | null = null;
function daemonVersion(): { ok: boolean; detail: string } {
  const base = OLLAMA_BASE();
  if (verCache && verCache.base === base && Date.now() - verCache.at < PROBE_CACHE_MS()) return verCache.v;
  const v = daemonVersionOnce();
  verCache = { at: Date.now(), base, v };
  return v;
}
function daemonVersionOnce(): { ok: boolean; detail: string } {
  try {
    const r = Bun.spawnSync(["curl", "-sf", "-m", env("APIPLAN_OLLAMA_PROBE_SECS", "1"), `${OLLAMA_BASE()}/api/version`], { stderr: "ignore" });
    if (!r.success) return { ok: false, detail: "no answer" };
    const v = JSON.parse(new TextDecoder().decode(r.stdout))?.version;
    return { ok: true, detail: v ? `ollama ${v}` : "ollama" };
  } catch (e: any) {
    // spawnSync throws when curl itself cannot be run. That is not a logged-out state.
    return { ok: false, detail: `could not run curl (${e?.message ?? e})` };
  }
}

// ── message shaping ───────────────────────────────────────────────────────────
/**
 * One Turn → one or more ollama messages. A tool RESULT is its own `role: "tool"` message
 * there (it is not content of the user turn), which is why this returns a list.
 * Images ride as `images: [<base64>]` — ollama takes raw base64, never a data: URI and
 * never a URL, so a URL-only image is dropped with its text kept rather than sent as a
 * string of characters the model would read as prose.
 */
/**
 * providers.ts exports the same flattener (`flatText`), and this does NOT import it: that
 * file imports THIS one to register the provider, and a value import back would close the
 * cycle — bun then throws "Cannot access before initialization" for whichever module is
 * entered first. Four lines of duplication buy an acyclic module graph.
 */
const flatText = (c: any): string =>
  typeof c === "string" ? c
  : Array.isArray(c) ? c.map(flatText).join("")
  : c === undefined || c === null ? ""
  : typeof c?.text === "string" ? c.text
  : JSON.stringify(c);

function toOllamaMessages(t: Turn): any[] {
  const out: any[] = [];
  for (const r of t.toolResults ?? []) {
    out.push({ role: "tool", content: flatText(r.content), tool_call_id: r.toolUseId, ...((r as any).name ? { tool_name: (r as any).name } : {}) });
  }
  const images = (t.images ?? []).map((im) => im.base64).filter(Boolean) as string[];
  const calls = (t.toolUses ?? []).map((u) => ({ id: u.id, function: { name: u.name, arguments: u.input ?? {} } }));
  if (t.text || images.length || calls.length || !out.length) {
    out.push({
      role: t.role, content: t.text ?? "",
      ...(images.length ? { images } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  return out;
}
/** The same Turn in OpenAI's shape, for the compat wire. */
function toCompatMessages(t: Turn): any[] {
  const out: any[] = [];
  for (const r of t.toolResults ?? []) out.push({ role: "tool", tool_call_id: r.toolUseId, content: flatText(r.content) });
  const calls = (t.toolUses ?? []).map((u) => ({ id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } }));
  const parts: any[] = [];
  if (t.text) parts.push({ type: "text", text: t.text });
  for (const im of t.images ?? []) if (im.base64) parts.push({ type: "image_url", image_url: { url: `data:${im.mediaType ?? "image/png"};base64,${im.base64}` } });
  if (parts.length > 1 || calls.length || t.text || !out.length) {
    out.push({ role: t.role, content: parts.length > 1 ? parts : t.text ?? "", ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return out;
}
/** A ToolDef → ollama's function shape (the OpenAI spelling, on both wires). */
const toOllamaTool = (t: ToolDef) => ({
  type: "function",
  function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } },
});

// ── stream events ─────────────────────────────────────────────────────────────
const STOP: Record<string, "end_turn" | "max_tokens" | "stop_sequence" | "tool_use"> = {
  stop: "end_turn", length: "max_tokens", load: "end_turn", unload: "end_turn",
};
/**
 * ollama hands over a COMPLETE tool call in one object — name and arguments together, never
 * a fragment — so it takes the contract's whole-call shape (`toolCallDone`, the same one
 * Gemini uses) rather than the start/args/stop triple that exists for backends which stream
 * arguments as partial JSON. The dialect layer opens, fills and closes the block on the spot.
 * Native sends `arguments` as a real OBJECT; the compat endpoint sends it as a JSON string.
 * Both are passed through untouched — `args` is `any`, and re-encoding is how arguments get
 * corrupted.
 */
function toolDone(tc: any): Delta["toolCallDone"] {
  const fn = tc?.function ?? {};
  const name = fn.name ?? tc?.name ?? "";
  const index = typeof fn.index === "number" ? fn.index : typeof tc?.index === "number" ? tc.index : 0;
  return { id: tc?.id || `call_${name || "tool"}_${index}`, name, args: fn.arguments ?? {} };
}

/** The native NDJSON line. `done` carries the counts nothing else here can measure. */
function nativeDeltas(ev: any): Delta[] {
  const base: Delta = {};
  if (ev?.model) base.served = ev.model;
  const msg = ev?.message ?? {};
  if (typeof msg.thinking === "string" && msg.thinking) base.reasoning = msg.thinking;
  if (typeof msg.content === "string" && msg.content) base.text = msg.content;
  if (ev?.done) {
    const usage: { input?: number; output?: number } = {};
    if (typeof ev.prompt_eval_count === "number") usage.input = ev.prompt_eval_count;
    if (typeof ev.eval_count === "number") usage.output = ev.eval_count;
    if (usage.input !== undefined || usage.output !== undefined) base.usage = usage;
    const stop = STOP[ev.done_reason ?? "stop"];
    if (stop) base.stopReason = stop;
  }
  const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (!calls.length) return [base];
  // The first call rides with the text/usage of this event; the rest are Deltas of their
  // own — which is the whole reason deltas() exists, since ollama batches parallel calls
  // into ONE object and a single-Delta return would drop every one after the first.
  base.stopReason = "tool_use";
  return calls.map((c, i) => (i === 0 ? { ...base, toolCallDone: toolDone(c) } : { toolCallDone: toolDone(c) }));
}

/** The compat SSE chunk — the same facts in OpenAI's clothes. */
function compatDeltas(ev: any): Delta[] {
  const ch = ev?.choices?.[0] ?? {};
  const d = ch.delta ?? ch.message ?? {};
  const base: Delta = {};
  if (ev?.model) base.served = ev.model;
  if (typeof d.reasoning === "string" && d.reasoning) base.reasoning = d.reasoning;
  if (typeof d.reasoning_content === "string" && d.reasoning_content) base.reasoning = (base.reasoning ?? "") + d.reasoning_content;
  if (typeof d.content === "string" && d.content) base.text = d.content;
  if (ev?.usage) {
    const usage: { input?: number; output?: number } = {};
    if (typeof ev.usage.prompt_tokens === "number") usage.input = ev.usage.prompt_tokens;
    if (typeof ev.usage.completion_tokens === "number") usage.output = ev.usage.completion_tokens;
    if (usage.input !== undefined || usage.output !== undefined) base.usage = usage;
  }
  const fin = ch.finish_reason;
  if (fin) base.stopReason = fin === "tool_calls" ? "tool_use" : STOP[fin] ?? "end_turn";
  const calls: any[] = Array.isArray(d.tool_calls) ? d.tool_calls : [];
  if (!calls.length) return [base];
  return calls.map((c, i) => (i === 0 ? { ...base, toolCallDone: toolDone(c) } : { toolCallDone: toolDone(c) }));
}

export const ollama: Provider & StreamShape = {
  id: "ollama",
  label: "Ollama (local models on this machine)",
  // The native endpoint frames with newlines, not blank-line-separated `data:` events.
  get framing() { return WIRE() === "compat" ? ("sse" as const) : ("ndjson" as const); },
  probe() {
    const v = daemonVersion();
    if (!v.ok) return {
      connected: false,
      detail: `${OLLAMA_BASE()} — ${v.detail}`,
      loginHint: "start the daemon (`ollama serve`, or open the Ollama app), or point APIPLAN_OLLAMA_BASE at the machine that runs it",
    };
    // There is no account and no expiry here — the only thing that can be wrong past this
    // point is an empty library, and that is a `ollama pull`, not a login.
    return { connected: true, detail: `${OLLAMA_BASE()} · ${v.detail} · no account, no token, no quota`, loginHint: "" };
  },
  creds(): Creds {
    const v = daemonVersion();
    if (!v.ok) throw new Error(`no ollama daemon at ${OLLAMA_BASE()} (${v.detail}) — start it with \`ollama serve\`, or set APIPLAN_OLLAMA_BASE to where it runs.`);
    // A local daemon needs no credential. A REMOTE one (a tunnel, ollama's own cloud) can
    // sit behind a bearer token, so an env key is honoured when present and absent
    // otherwise — sending `Authorization: Bearer ` to a local daemon is a 400 waiting.
    return { token: process.env.OLLAMA_API_KEY ?? "", source: OLLAMA_BASE() };
  },
  /**
   * ollama's thinking switch is ON or OFF, not a dial — so advertising five levels would be
   * a lie. `low` means think:false, anything else means think:true; a model whose
   * capabilities do not include `thinking` advertises no efforts at all.
   */
  efforts: (m) => (capable(m.id, "thinking") ? ["low", "high"] : []),
  build(m, turns, o, c): Built {
    const compat = WIRE() === "compat";
    const meta = ollamaMeta()[m.id] ?? {};
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: compat ? "text/event-stream" : "application/x-ndjson",
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
    };
    const tools = o.tools ?? [];
    const wantTools = tools.length > 0 && capable(m.id, "tools");
    const choice = o.toolChoice;

    if (compat) {
      const body: any = {
        model: m.id, stream: true, stream_options: { include_usage: true },
        messages: [...(o.system ? [{ role: "system", content: o.system }] : []), ...turns.flatMap(toCompatMessages)],
      };
      if (o.temperature !== undefined) body.temperature = o.temperature;
      if (o.maxTokens) body.max_tokens = o.maxTokens;
      if (wantTools) {
        body.tools = tools.map(toOllamaTool);
        if (choice) body.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
      }
      return { url: `${OLLAMA_BASE()}/v1/chat/completions`, headers, body };
    }

    const options: any = {};
    // The context the model was BUILT with, capped by what this machine should allocate.
    // Nothing here invents a number: an unknown context length sends no num_ctx at all.
    if (meta.ctx) options.num_ctx = Math.min(meta.ctx, CTX_CAP());
    if (o.temperature !== undefined) options.temperature = o.temperature;
    if (o.maxTokens) options.num_predict = o.maxTokens;

    const body: any = {
      model: m.id, stream: true,
      messages: [...(o.system ? [{ role: "system", content: o.system }] : []), ...turns.flatMap(toOllamaMessages)],
    };
    if (Object.keys(options).length) body.options = options;
    if (capable(m.id, "thinking")) body.think = o.thinkOff ? false : o.effort ? o.effort !== "low" : false;
    if (wantTools) body.tools = tools.map(toOllamaTool);
    if (KEEP_ALIVE()) body.keep_alive = KEEP_ALIVE();
    return { url: `${OLLAMA_BASE()}/api/chat`, headers, body };
  },
  /**
   * The native stream marks its last object `done:true`; the OpenAI-compat shape ends with
   * a finish_reason (or is a whole non-stream completion). A daemon killed mid-generation
   * sends neither, which is exactly what the truncation check is looking for.
   */
  terminal: (ev) => ev?.done === true || ev?.object === "chat.completion"
                 || !!ev?.choices?.[0]?.finish_reason,
  /** One event can be several tool calls; deltas() is the honest shape, delta() the first. */
  deltas(ev: any): Delta[] {
    if (typeof ev?.error === "string") return [{ error: ev.error }];
    if (ev?.error?.message) return [{ error: ev.error.message }];
    return ev?.object === "chat.completion.chunk" || ev?.object === "chat.completion" ? compatDeltas(ev) : nativeDeltas(ev);
  },
  delta(ev: any): Delta {
    return ollama.deltas!(ev)[0] ?? {};
  },
  explain(status, body) {
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body)?.error ?? msg; } catch {}
    if (status === 404 && /not found/i.test(msg))
      return `that model is not pulled on this machine — \`ollama pull <name>\` first, then \`apiplan models --refresh ollama\`. The name must include its tag exactly as \`ollama list\` prints it.`;
    if (status === 400 && /does not support tools/i.test(msg))
      return "this model has no tool capability, and the request carried tools — `ollama show <name>` lists its capabilities; pick a model whose list includes `tools`.";
    if (status === 400 && /think/i.test(msg))
      return "this model has no thinking capability, and the request asked for it — run `apiplan models --refresh ollama` so the capability sidecar matches what is installed.";
    if (status === 500 && /memory|resources/i.test(msg))
      return "the daemon could not fit the model — lower APIPLAN_OLLAMA_MAX_CTX, or unload the other resident model (`ollama stop <name>`).";
    return undefined;
  },
};

// ── self-registration ─────────────────────────────────────────────────────────
/**
 * Ask the daemon what this machine has, and write it into the registry cache.
 *
 * This used to live inside the CLI's `apiplan models --refresh`, which made every local
 * model a MANUAL step: a server started against a cold state dir served ZERO ollama models
 * and answered 404 for `heretic` until a human ran the CLI. That is a seamlessness bug, not
 * a preference — it worked on the machine where somebody had run the command and nowhere
 * else. The refresh belongs where the FACT lives (this provider), so both the CLI and the
 * API server call the same one, and the server can call it for itself at startup.
 *
 * Costs nothing and needs nobody: /api/tags and /api/show are loopback reads with no login,
 * no quota and no weight loading. Throws only so the CLI can print WHY; the server's
 * ensureOllama() swallows it, because "no daemon on this machine" is a normal state.
 */
export async function refreshOllama(): Promise<{ count: number; withTools: number; base: string }> {
  const base = OLLAMA_BASE();
  const tags: any = await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })).json();
  // Newest-modified first: with no version to compare, list order IS alias order, so
  // `heretic` resolves to the heretic tag this machine touched last.
  const local = (tags?.models ?? []).slice().sort((a: any, b: any) => String(b.modified_at ?? "").localeCompare(String(a.modified_at ?? "")));
  if (!local.length) throw new Error("no models pulled — `ollama pull <name>` first");
  const meta: Record<string, OllamaMeta> = {};
  const list: { id: string; label: string; efforts?: string[] }[] = [];
  for (const mo of local) {
    const size = mo.size ? ` · ${(mo.size / 1e9).toFixed(1)} GB` : "";
    const params = mo.details?.parameter_size ? ` · ${mo.details.parameter_size}` : "";
    let caps: string[] = [], ctx: number | undefined;
    try {
      // One /api/show per model — a metadata read; it does NOT load the weights.
      const sh: any = await (await fetch(`${base}/api/show`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: mo.name }), signal: AbortSignal.timeout(10000),
      })).json();
      caps = Array.isArray(sh?.capabilities) ? sh.capabilities : [];
      const ctxKey = Object.keys(sh?.model_info ?? {}).find((k) => k.endsWith(".context_length"));
      ctx = ctxKey ? Number(sh.model_info[ctxKey]) || undefined : undefined;
    } catch { /* a model that will not describe itself still calls — it just gets defaults */ }
    meta[mo.name] = { ...(ctx ? { ctx } : {}), capabilities: caps };
    list.push({ id: mo.name, label: `${mo.name}${params}${size}`, efforts: caps.includes("thinking") ? ["low", "high"] : [] });
  }
  saveModels("ollama", list);
  writeJson(OLLAMA_META_FILE(), { fetched_at: Date.now(), models: meta });
  metaCache = null;   // the sidecar just changed on disk; do not serve the 5s-old copy
  return { count: list.length, withTools: list.filter((l) => meta[l.id]?.capabilities?.includes("tools")).length, base };
}
