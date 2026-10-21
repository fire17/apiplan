// usage-account-alert.test.ts — `apiplan usage --account`: one line per provider that warns before a
// subscription window caps out, so a watchdog sees it coming instead of agents going deaf on 429s.
// The case that asked for it (2026-10-21 19:40Z): srv2's Anthropic account hit seven_day 100% and
// every agent on it got "Request rejected (429)" until the 00:00Z reset.
import { describe, expect, test } from "bun:test";
import { accountAlert, type ProviderUsage } from "../src/usage.ts";

const NOW = Date.parse("2026-10-21T20:03:30Z");
const u = (five: number | null, seven: number | null, extra: Record<string, number> = {}, more: Partial<ProviderUsage> = {}): ProviderUsage => ({
  account: null, five_hour: five === null ? null : { used_percent: five, resets_at: "2026-10-21T23:50:00Z" },
  seven_day: seven === null ? null : { used_percent: seven, resets_at: "2026-10-22T00:00:00Z" },
  extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { used_percent: v, resets_at: null }])),
  source: "test", fetched_at: new Date(NOW).toISOString(), ...more } as ProviderUsage);

describe("accountAlert", () => {
  test("the srv2 case: weekly 100% is CAPPED with its reset, 5h stays informational", () => {
    const a = accountAlert({ anthropic: u(9, 100), openai: u(null, 80) }, { warnAt: 90, now: NOW });
    expect(a.level).toBe("capped");
    expect(a.lines[0]).toBe("CAPPED anthropic weekly 100% (resets 2026-10-22T00:00:00Z, in 3h56m) · 5-hour 9%");
    expect(a.lines[1]).toBe("ok openai weekly 80%");
  });

  test("90% warns, 89% does not; the worst window per provider leads the line", () => {
    expect(accountAlert({ anthropic: u(20, 90) }, { warnAt: 90, now: NOW })).toMatchObject({ level: "warn", lines: ["WARN anthropic weekly 90% (resets 2026-10-22T00:00:00Z, in 3h56m) · 5-hour 20%"] });
    expect(accountAlert({ anthropic: u(20, 89) }, { warnAt: 90, now: NOW }).level).toBe("ok");
    expect(accountAlert({ anthropic: u(95, 40) }, { warnAt: 90, now: NOW }).lines[0]).toMatch(/^WARN anthropic 5-hour 95% .*· weekly 40%$/);
    expect(accountAlert({ anthropic: u(10, 10, { opus_weekly: 93 }) }, { warnAt: 90, now: NOW }).lines[0]).toMatch(/^WARN anthropic opus_weekly 93%/);
  });

  test("a provider that reports nothing or errors is UNKNOWN, never silently ok", () => {
    const a = accountAlert({ anthropic: u(null, null, {}, { error: "token expired" } as any) }, { warnAt: 90, now: NOW });
    expect(a.level).toBe("unknown");
    expect(a.lines[0]).toBe("UNKNOWN anthropic: token expired");
  });

  test("the most severe line sets the level: capped > warn > unknown > ok", () => {
    expect(accountAlert({ anthropic: u(1, 1), openai: u(91, 1) }, { warnAt: 90, now: NOW }).level).toBe("warn");
    expect(accountAlert({ anthropic: u(null, null, {}, { error: "x" } as any), openai: u(1, 1) }, { warnAt: 90, now: NOW }).level).toBe("unknown");
  });
});
