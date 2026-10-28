/**
 * GET /v1/usage under an account pool (Tami ACA9819E, 2026-10-28): the dashboard showed the capped
 * base well (100%) while another member served. pooledUsage() reports the ACTIVE member's windows;
 * only the owner sees the member list. Also: the owner key's ledger rows are labelled "owner".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPools } from "../src/account-pool.ts";
import { pooledUsage } from "../src/api.ts";
import { totalsByKey } from "../src/serve-keys.ts";

const HOUR = 3600_000;
const saved = { dir: process.env.APIPLAN_ANTHROPIC_POOL_DIR, st: process.env.APIPLAN_POOL_STATE };
afterEach(() => {
  for (const [k, v] of [["APIPLAN_ANTHROPIC_POOL_DIR", saved.dir], ["APIPLAN_POOL_STATE", saved.st]] as const)
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  resetPools();
});

function pool() {
  const d = mkdtempSync(join(tmpdir(), "pooled-usage-"));
  writeFileSync(join(d, "alice.json"), JSON.stringify({ claudeAiOauth: { accessToken: "AT-fake-a", expiresAt: Date.now() + 6 * HOUR, scopes: ["user:inference"] } }));
  const st = join(d, "state.json");
  writeFileSync(st, JSON.stringify({ v: 2, providers: { anthropic: { active: "alice", switched_at: 1, capped: { base: Date.now() + HOUR },
    usage: { base: { seven_day: 100, five_hour: 3, seven_day_resets_at: "2026-10-29T00:00:00Z", at: 1 },
      alice: { seven_day: 1, five_hour: 7, seven_day_resets_at: "2026-11-04T00:00:00Z", five_hour_resets_at: "2026-10-28T12:00:00Z", at: 1 } } } } }));
  process.env.APIPLAN_ANTHROPIC_POOL_DIR = d;
  process.env.APIPLAN_POOL_STATE = st;
  resetPools();
}
const baseUsage = () => ({ anthropic: { plan: "max", source: "ratelimit-headers", seven_day: { used_percent: 100, resets_at: "x" }, five_hour: { used_percent: 3, resets_at: "y" } } });

describe("pooledUsage", () => {
  test("no pool: the answer is unchanged", () => {
    delete process.env.APIPLAN_ANTHROPIC_POOL_DIR; resetPools();
    const u = baseUsage();
    expect(pooledUsage(u, true)).toEqual(u);
  });
  test("pooled: windows are the ACTIVE member's; the owner sees every member", () => {
    pool();
    const a = pooledUsage(baseUsage(), true).anthropic;
    expect(a.seven_day).toEqual({ used_percent: 1, resets_at: "2026-11-04T00:00:00Z" });
    expect(a.five_hour.used_percent).toBe(7);
    expect(a.plan).toBe("max");
    expect(a.source).toContain("active alice");
    expect(a.pool.map((m: any) => m.label).sort()).toEqual(["alice", "base"]);
  });
  test("pooled: any other caller gets the active % only — no member names", () => {
    pool();
    const a = pooledUsage(baseUsage(), false).anthropic;
    expect(a.seven_day.used_percent).toBe(1);
    expect(a.pool).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("alice");
  });
});

test("the owner key's ledger rows are labelled owner", () => {
  const line = (key_id: string, label: string) => ({ ts: "2026-10-28T00:00:00Z", key_id, label, model: "m", status: 200, input_tokens: 1, output_tokens: 1 } as any);
  const rows = totalsByKey([line("legacy", "legacy"), line("abc12345", "friend-a")]);
  expect(rows.find((r) => r.key_id === "legacy")!.label).toBe("owner");
  expect(rows.find((r) => r.key_id === "abc12345")!.label).toBe("friend-a");
});
