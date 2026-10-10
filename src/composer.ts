// composer.ts — Codex "composer predictions", decomposed: predict the user's NEXT message
// from a conversation, the way the Codex desktop app does it, on the same subscription.
//
// Owner's ask (fire17, 2026-10-10 15:15–15:31, WA ACC09BD5 / AC0A6436 / ACD8E37F): map exactly
// how Codex does Composer — model, calls, inputs, outputs, which history — and give us our own
// `composer` CLI and API, the way APIPlan decomposed every other provider. Full evidence:
// docs/COMPOSER.md. The mechanism, as read from the shipped app (ChatGPT.app 26.1007.21159,
// .vite/build/main-*.js, codename "cumberbatch") and github.com/openai/codex:
//
//   1. GET chatgpt.com/backend-api/wham/predictions/config  (cached 5 min by the app)
//      → { is_enabled, prompt, prompt_version, prediction_reasoning_effort,
//          unsupported_models[], sample_rate, … }. The PROMPT is server-owned and versioned.
//   2. The app forks the finished thread (app-server `thread/fork` with
//      experimentalPredictionMode: true, ephemeral, threadSource "composer_predictions"):
//      same model, tools, instructions and history as the parent, so the whole prefix is a
//      prompt-cache read.
//   3. One more turn on the fork: a USER message `${prompt}\n\nReturn only JSON matching this
//      schema: ${schema}.` with turnTrigger "composer_predictions" and the config's effort.
//      On the wire (POST /backend-api/codex/responses) the only thing marking it as a
//      prediction is the turn metadata: thread_source + turn_trigger = "composer_predictions"
//      (header x-codex-turn-metadata and client_metadata["x-codex-turn-metadata"]).
//   4. The reply is JSON {"suggestion": string|null}; the app shows it as ghost text, Tab
//      accepts it, nothing is ever sent automatically.
//
// This module does steps 1, 3 and 4 directly against the Responses backend. Step 2 has no
// equivalent outside the app-server: we cannot fork a live Codex thread from here, so the
// conversation is REBUILT from its visible messages (a Codex rollout, a Claude Code
// transcript, or caller-supplied turns). That loses the parent's tools/instructions prefix,
// so a prediction here is a cache read only against our own previous prediction calls.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { openai, type Turn } from "./providers.ts";
import { openProviderRequest } from "./provider-transport.ts";
import { responsesUsage } from "./responses-wire.ts";
import { resolve as resolveModel, type Model } from "./registry.ts";

/** The app's own thread-source / turn-trigger label for a prediction turn. */
export const PREDICTION_SOURCE = "composer_predictions";

/**
 * The response schema string the Codex TUI appended (codex-rs/tui/src/app/prompt_suggestions.rs
 * @ e154f7b807). The desktop app appends its zod schema serialised the same way: one object,
 * one required nullable string `suggestion`, nothing else.
 */
export const SUGGESTION_SCHEMA = `{"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}`;

/**
 * The server prompt as served to this account on 2026-10-10 (prompt_version "5"). Used ONLY
 * when the live config cannot be read; `promptVersion` then says "fallback-5" so a caller can
 * tell a live prompt from this copy.
 */
export const FALLBACK_PROMPT = [
  "This is an app-generated request for a suggested next user message. The user did not write this message.",
  "",
  "Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.",
  "",
  "Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.",
  "",
  "Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation.",
].join("\n");

/** The fields of /wham/predictions/config this module reads; the rest pass through. */
export type PredictionConfig = {
  is_enabled: boolean;
  prompt: string;
  prompt_version: string;
  prediction_reasoning_effort: string | null;
  unsupported_models?: string[];
  sample_rate?: number;
  [k: string]: unknown;
};

export const FALLBACK_CONFIG: PredictionConfig = {
  is_enabled: true, prompt: FALLBACK_PROMPT, prompt_version: "fallback-5", prediction_reasoning_effort: "high",
  unsupported_models: ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

const CONFIG_TTL_MS = 5 * 60_000;   // the app's own staleTime (3e5)
let configCache: { at: number; account: string; cfg: PredictionConfig } | null = null;

/** Validate a config body the way the app's zod schema does; null when it does not fit. */
export function parseConfig(j: any): PredictionConfig | null {
  if (!j || typeof j !== "object" || typeof j.is_enabled !== "boolean" || typeof j.prompt !== "string" || typeof j.prompt_version !== "string") return null;
  if (j.sample_rate !== undefined && !(typeof j.sample_rate === "number" && j.sample_rate >= 0 && j.sample_rate <= 1)) return null;
  if (j.unsupported_models !== undefined && !(Array.isArray(j.unsupported_models) && j.unsupported_models.every((m: unknown) => typeof m === "string"))) return null;
  return { ...j, prediction_reasoning_effort: j.prediction_reasoning_effort || null };
}

/**
 * The live prediction config for the logged-in Codex account. `source` says whether it came
 * from the server, the 5-minute cache, or the fallback copy (with the reason).
 */
export async function predictionConfig(opts: { fresh?: boolean; fetchImpl?: typeof fetch } = {}): Promise<{ cfg: PredictionConfig; source: "live" | "cache" | "fallback"; error?: string }> {
  let c: ReturnType<typeof openai.creds>;
  try { c = openai.creds(); } catch (e: any) { return { cfg: FALLBACK_CONFIG, source: "fallback", error: e.message }; }
  const account = c.account ?? "";
  if (!opts.fresh && configCache && configCache.account === account && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return { cfg: configCache.cfg, source: "cache" };
  }
  try {
    const r = await (opts.fetchImpl ?? fetch)(`${process.env.APIPLAN_OPENAI_BASE ?? "https://chatgpt.com"}/backend-api/wham/predictions/config`, {
      headers: { authorization: `Bearer ${c.token}`, "chatgpt-account-id": account, originator: process.env.APIPLAN_ORIGINATOR ?? "codex_cli_rs" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { cfg: FALLBACK_CONFIG, source: "fallback", error: `config HTTP ${r.status}` };
    const cfg = parseConfig(await r.json());
    if (!cfg) return { cfg: FALLBACK_CONFIG, source: "fallback", error: "config body did not match the expected shape" };
    configCache = { at: Date.now(), account, cfg };
    return { cfg, source: "live" };
  } catch (e: any) {
    return { cfg: FALLBACK_CONFIG, source: "fallback", error: e?.message ?? String(e) };
  }
}

/** The user message appended to the conversation — the app's exact template. */
export function predictionMessage(prompt: string): string {
  return `${prompt}\n\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`;
}

/**
 * The reply → suggestion, with the Codex TUI's acceptance rules (prompt_suggestions.rs
 * parse_suggestion): JSON `{"suggestion": …}`, a non-empty trimmed string of at most 240
 * characters with no control or line-separator characters. Anything else is null. A reply
 * wrapped in a ```json fence or prose is tolerated by taking the first {...} object in it.
 */
export function parseSuggestion(reply: string): string | null {
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  let j = tryParse(reply.trim());
  if (j === undefined) { const m = reply.match(/\{[\s\S]*\}/); if (m) j = tryParse(m[0]); }
  if (!j || typeof j !== "object" || Array.isArray(j) || !("suggestion" in j)) return null;
  if (typeof j.suggestion !== "string") return null;
  const text = j.suggestion.trim();
  if (!text || [...text].length > 240) return null;
  if ([...text].some((ch) => { const c = ch.codePointAt(0)!; return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; })) return null;
  return text;
}

/** The turn metadata Codex attaches to a prediction turn (core/src/responses_metadata.rs). */
export function predictionMetadata(o: { threadId?: string; forkedFrom?: string; turnId?: string }): Record<string, unknown> {
  return {
    ...(o.threadId ? { session_id: o.threadId, thread_id: o.threadId } : {}),
    ...(o.turnId ? { turn_id: o.turnId } : {}),
    request_kind: "turn",
    ...(o.forkedFrom ? { forked_from_thread_id: o.forkedFrom } : {}),
    thread_source: PREDICTION_SOURCE,
    turn_trigger: PREDICTION_SOURCE,
  };
}

export type PredictOpts = {
  model: Model;
  effort?: string;
  /** Override the server prompt (testing / experiments). */
  prompt?: string;
  /** Send the composer_predictions turn metadata (default true — what the app sends). */
  tag?: boolean;
  /** The Codex thread this conversation came from, recorded as forked_from_thread_id. */
  forkedFrom?: string;
  promptCacheKey?: string;
  system?: string;
  signal?: AbortSignal;
  /** Injected for tests. */
  config?: PredictionConfig;
  fetchImpl?: typeof fetch;
};

export type Prediction = {
  object: "composer.prediction";
  suggestion: string | null;
  raw: string;
  model: string;
  served?: string;
  effort: string | null;
  prompt_version: string;
  config_source: "live" | "cache" | "fallback" | "given";
  tagged: boolean;
  /** Advisory: the server config lists this model as unsupported for predictions. */
  unsupported_model?: boolean;
  usage?: { input_tokens?: number; cached_tokens?: number; output_tokens?: number; reasoning_tokens?: number };
  latency_ms: number;
  /** x-codex-*-used-percent as the backend reported them on this response. */
  windows?: Record<string, string>;
};

/**
 * One prediction: the conversation + the prediction message → {suggestion}. Throws on an
 * upstream error (the message carries the backend's own words); a reply that is not a valid
 * suggestion is a normal `suggestion: null`, as in the app.
 */
export async function predict(turns: Turn[], o: PredictOpts): Promise<Prediction> {
  if (o.model.provider !== "openai") throw new Error(`composer predictions run on the Codex subscription (provider openai); '${o.model.id}' is ${o.model.provider}`);
  if (!turns.some((t) => t.text?.trim())) throw new Error("composer needs a conversation with at least one message");
  const t0 = performance.now();
  const got = o.config ? { cfg: o.config, source: "given" as const } : await predictionConfig({ fetchImpl: o.fetchImpl });
  const cfg = got.cfg;
  const effort = o.effort ?? cfg.prediction_reasoning_effort ?? undefined;
  const tag = o.tag !== false;
  const all: Turn[] = [...turns, { role: "user", text: predictionMessage(o.prompt ?? cfg.prompt) }];
  const c = openai.creds();
  const built = openai.build(o.model, all, { effort, system: o.system, promptCacheKey: o.promptCacheKey } as any, c);
  if (tag) {
    const meta = JSON.stringify(predictionMetadata({ forkedFrom: o.forkedFrom, threadId: o.promptCacheKey }));
    built.headers["x-codex-turn-metadata"] = meta;
    built.body.client_metadata = { ...(built.body.client_metadata ?? {}), "x-codex-turn-metadata": meta };
  }
  const res = o.fetchImpl
    ? await o.fetchImpl(built.url, { method: "POST", headers: built.headers, body: JSON.stringify({ ...built.body, stream: true }), signal: o.signal })
    : await openProviderRequest(openai, built, o.signal);
  const windows: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (/^x-codex-(primary|secondary)-used-percent$|^x-codex-plan-type$/.test(k)) windows[k] = v; });
  if (!res.ok) {
    const raw = await res.text();
    let msg = raw.slice(0, 400);
    try { const j = JSON.parse(raw); msg = j?.error?.message || j?.detail || msg; } catch {}
    throw new Error(`prediction failed (${res.status}): ${msg}`);
  }
  let text = "", served: string | undefined, usage: Prediction["usage"], ended = false;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let ev: any; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (openai.terminal?.(ev)) ended = true;
      const d = openai.delta(ev);
      if (d.error) throw new Error(`prediction failed: ${d.error}`);
      if (d.served && !served) served = d.served;
      if (d.text) text += d.text;
      if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        const u = responsesUsage(ev.response);
        if (u) usage = { input_tokens: u.input, cached_tokens: u.cacheRead, output_tokens: u.output, reasoning_tokens: (u as any).reasoning };
      }
    }
  }
  if (!ended) throw new Error(`prediction stream ended before the backend reported completion (${text.length} chars received)`);
  return {
    object: "composer.prediction",
    suggestion: parseSuggestion(text),
    raw: text,
    model: o.model.id,
    ...(served ? { served } : {}),
    effort: effort ?? null,
    prompt_version: o.prompt ? "custom" : cfg.prompt_version,
    config_source: got.source,
    tagged: tag,
    ...(cfg.unsupported_models?.includes(o.model.id) ? { unsupported_model: true } : {}),
    ...(usage ? { usage } : {}),
    latency_ms: Math.round(performance.now() - t0),
    ...(Object.keys(windows).length ? { windows } : {}),
  };
}

// ─────────────────────────── conversation sources ───────────────────────────

/** Caller-supplied messages (OpenAI or Anthropic shape) → turns. System turns are dropped:
 *  a prediction reads the conversation, and `system` is passed separately. */
export function turnsFromMessages(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) throw new Error("messages must be an array of {role, content}");
  const out: Turn[] = [];
  for (const m of messages as any[]) {
    const role = m?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(m.content);
    if (text.trim()) out.push({ role, text });
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: any) => (typeof p === "string" ? p
    : p?.type === "text" || p?.type === "input_text" || p?.type === "output_text" ? p.text ?? "" : "")).filter(Boolean).join("\n");
}

/** Codex wraps harness context in user-role messages; they are not the user talking. */
const CODEX_CONTEXT = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md|<turn_aborted>|<subagent_notification>)/;

/**
 * A Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl) → its visible
 * user/assistant messages, in order. Developer messages, harness context, reasoning and tool
 * calls are skipped: the app's fork carries them, but here only the conversation is rebuilt.
 */
export function turnsFromCodexRollout(jsonl: string): Turn[] {
  const out: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    const p = r?.payload;
    if (r?.type !== "response_item" || p?.type !== "message") continue;
    if (p.role !== "user" && p.role !== "assistant") continue;
    const text = textOf(p.content);
    if (!text.trim() || (p.role === "user" && CODEX_CONTEXT.test(text))) continue;
    out.push({ role: p.role, text });
  }
  return out;
}

/** Claude Code wraps commands, hook output and reminders in tags; skip those turns. */
const CLAUDE_NOISE = /^\s*(<command-name>|<command-message>|<local-command-stdout>|<local-command-caveat>|<system-reminder>|<task-notification>|Caveat: The messages below)/;

/**
 * A Claude Code transcript (~/.claude/projects/<project>/<session id>.jsonl) → its visible
 * user/assistant text. Tool calls, tool results, thinking, meta rows and sidechains are
 * skipped.
 */
export function turnsFromClaudeTranscript(jsonl: string): Turn[] {
  const out: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if ((r?.type !== "user" && r?.type !== "assistant") || r.isMeta || r.isSidechain) continue;
    const role = r.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(r.message?.content);
    if (!text.trim() || CLAUDE_NOISE.test(text)) continue;
    // Consecutive assistant rows are one reply streamed as several blocks: join them.
    const prev = out[out.length - 1];
    if (prev && prev.role === role && role === "assistant") prev.text += "\n" + text;
    else out.push({ role, text });
  }
  return out;
}

/** Keep the newest turns whose text fits `maxChars` (whole turns, never a cut one). */
export function tailTurns(turns: Turn[], maxChars: number): Turn[] {
  let n = 0, i = turns.length;
  while (i > 0 && n + turns[i - 1].text.length <= maxChars) { n += turns[i - 1].text.length; i--; }
  if (i === turns.length && turns.length) i = turns.length - 1;   // always keep the last turn
  return turns.slice(i);
}

function newest(files: string[]): string | undefined {
  let best: string | undefined, at = -1;
  for (const f of files) { try { const m = statSync(f).mtimeMs; if (m > at) { at = m; best = f; } } catch {} }
  return best;
}

function walk(dir: string, depth: number, match: (f: string) => boolean, acc: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return acc; }
  for (const n of names) {
    const p = join(dir, n);
    if (depth > 0) { try { if (statSync(p).isDirectory()) { walk(p, depth - 1, match, acc); continue; } } catch { continue; } }
    if (match(n)) acc.push(p);
  }
  return acc;
}

/** A Codex thread id, rollout path, or "last" → the rollout file. */
export function findCodexRollout(ref: string, root = join(homedir(), ".codex", "sessions")): { file: string; threadId?: string } {
  if (existsSync(ref) && ref.endsWith(".jsonl")) return { file: ref, threadId: ref.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] };
  const files = walk(root, 3, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl") && (ref === "last" || n.includes(ref)));
  const file = newest(files);
  if (!file) throw new Error(ref === "last" ? `no Codex rollouts under ${root}` : `no Codex rollout for thread '${ref}' under ${root}`);
  return { file, threadId: file.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] };
}

/** A Claude Code session id, transcript path, or "last" → the transcript file. */
export function findClaudeTranscript(ref: string, root = join(homedir(), ".claude", "projects")): string {
  if (existsSync(ref) && ref.endsWith(".jsonl")) return ref;
  const files = walk(root, 1, (n) => n.endsWith(".jsonl") && (ref === "last" || n.startsWith(ref)));
  const file = newest(files);
  if (!file) throw new Error(ref === "last" ? `no Claude Code transcripts under ${root}` : `no Claude Code transcript '${ref}' under ${root}`);
  return file;
}

export const readText = (f: string) => readFileSync(f, "utf8");

// ─────────────────────────── the HTTP route ───────────────────────────

/** POST /v1/composer/predictions body. Exactly one conversation source. */
export type ComposerRequest = {
  messages?: unknown;
  /** A Codex thread id or "last" — owner only (it reads this machine's ~/.codex). */
  codex_thread?: string;
  /** A Claude Code session id or "last" — owner only (it reads this machine's ~/.claude). */
  claude_session?: string;
  model?: string; effort?: string; tag?: boolean; prompt?: string; system?: string; max_chars?: number;
  prompt_cache_key?: string;
};

/** An error that carries the HTTP status the route should answer with. */
export class ComposerError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/**
 * The route's whole logic, kept here so api.ts only dispatches. `allowLocalSources` is the
 * server's verdict on whether this caller may read the machine's own transcripts (the owner
 * on loopback, or the owner's key) — a per-client key never may.
 */
export async function predictFromRequest(body: ComposerRequest, o: { allowLocalSources: boolean; signal?: AbortSignal }): Promise<Prediction> {
  if (!body || typeof body !== "object") throw new ComposerError(400, "body must be a JSON object");
  const sources = ["messages", "codex_thread", "claude_session"].filter((k) => (body as any)[k] !== undefined);
  if (sources.length !== 1) throw new ComposerError(400, "give exactly one of messages, codex_thread, claude_session");
  if ((body.codex_thread !== undefined || body.claude_session !== undefined) && !o.allowLocalSources) {
    throw new ComposerError(403, "codex_thread / claude_session read this machine's transcripts: owner only — send messages instead");
  }
  const name = body.model ?? process.env.APIPLAN_COMPOSER_MODEL ?? "gpt-6-astra";
  const model = resolveModel(name);
  if (!model) throw new ComposerError(404, `unknown model '${name}'`);
  if (model.provider !== "openai") throw new ComposerError(400, `composer predictions run on the Codex subscription; '${name}' is ${model.provider}`);
  let turns: Turn[];
  let forkedFrom: string | undefined;
  try {
    if (body.messages !== undefined) turns = turnsFromMessages(body.messages);
    else if (body.codex_thread !== undefined) {
      const r = findCodexRollout(String(body.codex_thread));
      forkedFrom = r.threadId;
      turns = turnsFromCodexRollout(readText(r.file));
    } else turns = turnsFromClaudeTranscript(readText(findClaudeTranscript(String(body.claude_session))));
  } catch (e: any) { throw new ComposerError(e instanceof ComposerError ? e.status : 400, e.message); }
  const max = body.max_chars ?? 200_000;
  if (typeof max !== "number" || !(max > 0)) throw new ComposerError(400, "max_chars must be a positive number");
  turns = tailTurns(turns, max);
  if (!turns.length) throw new ComposerError(400, "the conversation has no user or assistant messages");
  try {
    return await predict(turns, {
      model, effort: body.effort, tag: body.tag, prompt: body.prompt, system: body.system,
      forkedFrom, promptCacheKey: body.prompt_cache_key, signal: o.signal,
    });
  } catch (e: any) {
    const m = /\((\d{3})\)/.exec(e.message);
    throw new ComposerError(m ? Number(m[1]) : 502, e.message);
  }
}
