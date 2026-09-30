// usage.test.ts — GET /v1/usage + `apiplan usage`: both vendors' subscription windows, the
// scope-refusal fallback onto unified rate-limit headers, and the token never leaving.
import { expect, test, describe, beforeEach } from "bun:test";
import { subscriptionUsage, resetUsageCache, type UsageDeps, type UsageProvider } from "../src/usage.ts";
import { serve } from "../src/api.ts";
import type { Creds } from "../src/providers.ts";

const A_TOK = "sk-ant-oat01-FAKE-anthropic-token-should-never-appear-0123456789";
const O_TOK = "eyFAKE.openai-access-token.should-never-appear-9876543210";
const NOW = Date.parse("2026-10-01T00:00:00Z");

const creds = (p: UsageProvider): Creds =>
  p === "anthropic" ? { token: A_TOK, source: "/tmp/fake-cred.json" } : { token: O_TOK, account: "acct-123", source: "/tmp/auth.json" };

const OAUTH_OK = {
  five_hour: { utilization: 13.0, resets_at: "2026-10-01T00:59:59.573430+00:00" },
  seven_day: { utilization: 26.0, resets_at: "2026-10-04T16:59:59.573448+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 4.0, resets_at: "2026-10-04T16:59:59+00:00" },
  extra_usage: { is_enabled: false, utilization: null },
};
// Shape measured live 2026-10-01 on a Pro account: the weekly window is `primary_window`.
const CODEX_OK = {
  email: "someone@example.com", plan_type: "pro",
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 239404, reset_at: 1791046996 },
    secondary_window: null,
  },
};
const CODEX_BOTH = {
  email: "p@example.com", plan_type: "plus",
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 71, limit_window_seconds: 604800, reset_at: 1759622400 },
  },
};
const UNIFIED = {
  "anthropic-ratelimit-unified-5h-utilization": "0.13",
  "anthropic-ratelimit-unified-5h-reset": "1790816400",
  "anthropic-ratelimit-unified-7d-utilization": "0.26",
  "anthropic-ratelimit-unified-7d-reset": "1791133200",
  "anthropic-ratelimit-unified-status": "allowed",
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
function mockFetch(routes: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) h[k.toLowerCase()] = String(v);
    const c: Call = { url: String(input), method: init.method ?? "GET", headers: h, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    return routes(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const J = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const deps = (f: typeof fetch): UsageDeps => ({ fetch: f, creds, now: () => NOW });
const noToken = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(A_TOK);
  expect(s).not.toContain(O_TOK);
};

beforeEach(() => { resetUsageCache(); delete process.env.APIPLAN_USAGE_ANTHROPIC_SOURCE; });

describe("subscriptionUsage", () => {
  test("both providers ok: 5h + weekly windows, extras, account, exact upstream headers", async () => {
    const { f, calls } = mockFetch((c) =>
      c.url.includes("/api/oauth/usage") ? J(OAUTH_OK) : c.url.includes("/codex/usage") ? J(CODEX_BOTH) : J({}, 404));
    const r = await subscriptionUsage(undefined, deps(f));
    expect(r.anthropic!.error).toBeUndefined();
    expect(r.anthropic!.source).toBe("oauth/usage");
    expect(r.anthropic!.five_hour).toEqual({ used_percent: 13, resets_at: "2026-10-01T00:59:59.573Z" });
    expect(r.anthropic!.seven_day!.used_percent).toBe(26);
    expect(r.anthropic!.extra.seven_day_sonnet.used_percent).toBe(4);
    expect(r.anthropic!.extra.seven_day_opus).toBeUndefined();
    expect(r.openai!.error).toBeUndefined();
    expect(r.openai!.account).toBe("p@example.com");
    expect(r.openai!.five_hour).toEqual({ used_percent: 42, resets_at: new Date(NOW + 3600_000).toISOString() });
    expect(r.openai!.seven_day).toEqual({ used_percent: 71, resets_at: new Date(1759622400_000).toISOString() });
    const oauth = calls.find((c) => c.url.includes("/api/oauth/usage"))!;
    expect(oauth.headers["anthropic-version"]).toBe("2023-06-01");
    expect(oauth.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const codex = calls.find((c) => c.url.includes("/codex/usage"))!;
    expect(codex.headers["chatgpt-account-id"]).toBe("acct-123");
    expect(codex.headers["user-agent"]).toMatch(/^codex_cli_rs\//);
    expect(calls.some((c) => c.url.includes("/v1/messages"))).toBe(false);
    noToken(r);
  });

  test("codex windows map by span, not position: a weekly primary_window is seven_day", async () => {
    const { f } = mockFetch((c) => (c.url.includes("/codex/usage") ? J(CODEX_OK) : J({}, 404)));
    const r = await subscriptionUsage("openai", deps(f));
    expect(r.openai!.five_hour).toBeNull();
    expect(r.openai!.seven_day!.used_percent).toBe(1);
    expect(r.openai!.plan).toBe("pro");
    expect(r.anthropic).toBeUndefined();
  });

  test("oauth 403 user:profile → unified-header probe; scope refusal is remembered", async () => {
    const { f, calls } = mockFetch((c) => {
      if (c.url.includes("/api/oauth/usage"))
        return J({ type: "error", error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" } }, 403);
      if (c.url.includes("/v1/messages")) return J({ type: "message" }, 200, UNIFIED);
      return J({}, 404);
    });
    const r = await subscriptionUsage("anthropic", deps(f));
    const a = r.anthropic!;
    expect(a.error).toBeUndefined();
    expect(a.source).toMatch(/^ratelimit-headers/);
    expect(a.source).toMatch(/lacks scope user:profile/);
    expect(a.five_hour).toEqual({ used_percent: 13, resets_at: new Date(1790816400_000).toISOString() });
    expect(a.seven_day).toEqual({ used_percent: 26, resets_at: new Date(1791133200_000).toISOString() });
    expect(a.status).toBe("allowed");
    const probe = calls.find((c) => c.url.includes("/v1/messages"))!;
    expect(probe.method).toBe("POST");
    expect(probe.body.max_tokens).toBe(1);
    expect(probe.body.model).toMatch(/haiku/);
    noToken(r);

    // Past the cache TTL, the same credential goes straight to the probe — no oauth retry.
    const later = await subscriptionUsage("anthropic", { fetch: f, creds, now: () => NOW + 61_000 });
    expect(later.anthropic!.source).toMatch(/skipped/);
    expect(calls.filter((c) => c.url.includes("/api/oauth/usage")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("/v1/messages")).length).toBe(2);
  });

  test("oauth 429 → header probe now, and oauth is held off for 5 minutes", async () => {
    const { f, calls } = mockFetch((c) => {
      if (c.url.includes("/api/oauth/usage")) return J({ type: "error", error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }, 429, { "retry-after": "0" });
      if (c.url.includes("/v1/messages")) return J({ type: "message" }, 200, UNIFIED);
      return J({}, 404);
    });
    const r = await subscriptionUsage("anthropic", deps(f));
    expect(r.anthropic!.error).toBeUndefined();
    expect(r.anthropic!.source).toMatch(/oauth\/usage HTTP 429/);
    expect(r.anthropic!.seven_day!.used_percent).toBe(26);
    const at = (ms: number) => subscriptionUsage("anthropic", { fetch: f, creds, now: () => NOW + ms });
    expect((await at(61_000)).anthropic!.source).toMatch(/held after a 429/);
    expect(calls.filter((c) => c.url.includes("/api/oauth/usage")).length).toBe(1);
    await at(301_000 + 61_000);
    expect(calls.filter((c) => c.url.includes("/api/oauth/usage")).length).toBe(2);
  });

  test("a 429 probe still yields the windows (the moment a switch matters most)", async () => {
    process.env.APIPLAN_USAGE_ANTHROPIC_SOURCE = "headers";
    const { f, calls } = mockFetch(() => J({ type: "error", error: { type: "rate_limit_error" } }, 429,
      { ...UNIFIED, "anthropic-ratelimit-unified-5h-utilization": "1.0", "anthropic-ratelimit-unified-status": "rejected" }));
    const r = await subscriptionUsage("anthropic", deps(f));
    expect(r.anthropic!.five_hour!.used_percent).toBe(100);
    expect(r.anthropic!.status).toBe("rejected");
    expect(calls.some((c) => c.url.includes("/api/oauth/usage"))).toBe(false);
  });

  test("codex HTML 403 → edge-WAF error string; anthropic unaffected", async () => {
    const { f } = mockFetch((c) =>
      c.url.includes("/codex/usage")
        ? new Response("<!DOCTYPE html><html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } })
        : J(OAUTH_OK));
    const r = await subscriptionUsage(undefined, deps(f));
    expect(r.openai!.error).toMatch(/edge WAF, not by auth \(HTTP 403, HTML body\)/);
    expect(r.openai!.five_hour).toBeNull();
    expect(r.anthropic!.error).toBeUndefined();
    expect(r.anthropic!.five_hour!.used_percent).toBe(13);
    noToken(r);
  });

  test("one provider down (network throws, creds missing) never breaks the other", async () => {
    const { f } = mockFetch((c) => {
      if (c.url.includes("anthropic.com")) throw new Error(`connect ECONNREFUSED Bearer ${A_TOK}`);
      return J(CODEX_BOTH);
    });
    const r = await subscriptionUsage(undefined, deps(f));
    expect(r.anthropic!.error).toMatch(/unreachable/);
    expect(r.anthropic!.error).toContain("<redacted>");
    expect(r.openai!.error).toBeUndefined();
    expect(r.openai!.seven_day!.used_percent).toBe(71);
    noToken(r);

    resetUsageCache();
    const noCreds = await subscriptionUsage(undefined, {
      fetch: f, now: () => NOW,
      creds: (p) => { if (p === "openai") throw new Error("no ~/.codex/auth.json — run `codex` and log in first."); return creds(p); },
    });
    expect(noCreds.openai!.error).toMatch(/^credential: no/);
  });

  test("responses are cached for the TTL — success and failure alike", async () => {
    let n = 0;
    const { f } = mockFetch((c) => { n++; return c.url.includes("/codex/usage") ? J({}, 500) : J(OAUTH_OK); });
    await subscriptionUsage(undefined, deps(f));
    await subscriptionUsage(undefined, deps(f));
    await subscriptionUsage(undefined, { fetch: f, creds, now: () => NOW + 30_000 });
    expect(n).toBe(2);
    await subscriptionUsage(undefined, { fetch: f, creds, now: () => NOW + 61_000 });
    expect(n).toBe(4);
  });
});

describe("GET /v1/usage", () => {
  test("serves the cached report, honours the key gate, validates ?provider", async () => {
    const { f } = mockFetch((c) => (c.url.includes("/codex/usage") ? J(CODEX_BOTH) : J(OAUTH_OK)));
    // Fill the in-process cache with mocked upstreams; the route then answers from it.
    await subscriptionUsage(undefined, { fetch: f, creds, now: Date.now });
    const s = serve({ port: 0, host: "127.0.0.1", token: "k" });
    try {
      expect((await fetch(`${s.url}/v1/usage`)).status).toBe(401);
      const r = await fetch(`${s.url}/v1/usage`, { headers: { authorization: "Bearer k" } });
      expect(r.status).toBe(200);
      const j: any = await r.json();
      expect(j.anthropic.five_hour.used_percent).toBe(13);
      expect(j.openai.seven_day.used_percent).toBe(71);
      noToken(j);
      const one: any = await (await fetch(`${s.url}/v1/usage?provider=openai`, { headers: { authorization: "Bearer k" } })).json();
      expect(Object.keys(one)).toEqual(["openai"]);
      expect((await fetch(`${s.url}/v1/usage?provider=gemini`, { headers: { authorization: "Bearer k" } })).status).toBe(400);
    } finally { s.stop(); }
  });
});
