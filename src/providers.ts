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
};
export type Creds = { token: string; account?: string; expiresAt?: number; source: string };
export type Built = { url: string; headers: Record<string, string>; body: any };
/**
 * What one stream event contributed. `text` is answer content, `reasoning` is
 * thinking, and `served` is the model id the API itself reports — the only
 * trustworthy proof of which model answered (a model's self-description is not).
 */
export type Delta = { text?: string; reasoning?: string; error?: string; served?: string };

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
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": return { reasoning: ev.delta ?? "" };
      case "response.failed": return { error: ev.response?.error?.message ?? "response failed" };
      case "response.error": case "error": return { error: ev.error?.message ?? ev.message ?? "stream error" };
      default: return {};
    }
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
