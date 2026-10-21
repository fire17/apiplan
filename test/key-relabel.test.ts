// key-relabel.test.ts — `apiplan keys label <id> <new label>`: rename a key's label in place.
//
// Tami, 2026-10-21 (voice ACD166DD): the API-keys view shows slugs ("mag 1, mag 4") instead of the
// people's names. A relabel is metadata only: same id, same secret (sha256), same created_at, so
// every launcher holding the key keeps working. Usage views show the CURRENT label for past
// requests too (the ledger keeps the label each request had; the store's label wins on display).
// The lunasight label is an access grant (/v1/lunasight/credential), so a relabel may never move a
// key into or out of that class.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKey, relabelKey, revokeKey, readStore, keyCache, totalsByKey, storeLabels, type LedgerLine } from "../src/serve-keys.ts";
import { serve } from "../src/api.ts";

const DIR = mkdtempSync(join(tmpdir(), "ap-relabel-"));
const ROOT = new URL("..", import.meta.url).pathname;

describe("relabelKey", () => {
  test("changes only the label: id, secret hash and created_at stay; the key still authenticates", () => {
    const file = join(DIR, "a", "keys.json");
    const { record, key } = createKey("mag1", file);
    const cache = keyCache(file);
    expect(cache.match(key)?.label).toBe("mag1");
    const r = relabelKey(record.id, "  Or  ", file);
    expect(r).toMatchObject({ id: record.id, label: "Or", sha256: record.sha256, created_at: record.created_at });
    const stored = readStore(file).keys.find((k) => k.id === record.id)!;
    expect(stored.label).toBe("Or");
    expect(stored.sha256).toBe(record.sha256);
    expect(cache.match(key)?.label).toBe("Or"); // a running server sees the new label live
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(key);
  });

  test("refuses: unknown id, empty label, a revoked key, a label another active key already has", () => {
    const file = join(DIR, "b", "keys.json");
    const a = createKey("mag2", file).record, b = createKey("Roee", file).record, c = createKey("old", file).record;
    revokeKey(c.id, file);
    expect(() => relabelKey("nope0000", "x", file)).toThrow(/no key/);
    expect(() => relabelKey(a.id, "   ", file)).toThrow(/label/);
    expect(() => relabelKey(c.id, "x", file)).toThrow(/revoked/);
    expect(() => relabelKey(a.id, "Roee", file)).toThrow(/already/);
    expect(relabelKey(b.id, "Roee", file).label).toBe("Roee"); // same label on itself is a no-op, not an error
    expect(readStore(file).keys.find((k) => k.id === a.id)!.label).toBe("mag2");
  });

  test("never moves a key into or out of the lunasight class (that label grants the Codex credential)", () => {
    const file = join(DIR, "c", "keys.json");
    const agent = createKey("agent-lunasight", file).record, app = createKey("lunasight", file).record, dev = createKey("lunasight-dad", file).record;
    expect(() => relabelKey(agent.id, "lunasight-tami", file)).toThrow(/lunasight/);
    expect(() => relabelKey(app.id, "LunaSight app", file)).toThrow(/lunasight/);
    expect(relabelKey(dev.id, "lunasight-abba", file).label).toBe("lunasight-abba"); // within the class is fine
  });
});

describe("usage views show the current label", () => {
  const line = (key_id: string, label: string): LedgerLine => ({ ts: new Date().toISOString(), key_id, label, route: "/v1/messages",
    provider: "anthropic", model: "m", stream: false, status: 200, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
    cache_write_tokens: 0, cost_usd: 0, ms: 1 } as any);

  test("totalsByKey takes the store's label over the label the ledger recorded", () => {
    const file = join(DIR, "d", "keys.json");
    const { record } = createKey("mag4", file);
    relabelKey(record.id, "Roee", file);
    const rows = totalsByKey([line(record.id, "mag4"), line("legacy", "legacy")], undefined, storeLabels(file));
    expect(rows.find((r) => r.key_id === record.id)!.label).toBe("Roee");
    expect(rows.find((r) => r.key_id === "legacy")!.label).toBe("legacy"); // not in the store: ledger label stays
    expect(totalsByKey([line(record.id, "mag4")])[0].label).toBe("mag4"); // without a store, unchanged behaviour
  });

  test("GET /v1/usage/keys shows the new name for requests made under the old one", async () => {
    const file = join(DIR, "e", "keys.json"), ledger = join(DIR, "e", "ledger.jsonl");
    const { record } = createKey("mag1", file);
    writeFileSync(ledger, JSON.stringify(line(record.id, "mag1")) + "\n");
    const saved = process.env.APIPLAN_USAGE_LEDGER; process.env.APIPLAN_USAGE_LEDGER = ledger;
    relabelKey(record.id, "Or", file);
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: file, token: "owner" });
    try {
      const j = await (await fetch(`${s.url}/v1/usage/keys`, { headers: { authorization: "Bearer owner" } })).json() as any;
      expect(j.keys.find((k: any) => k.key_id === record.id).label).toBe("Or");
    } finally { s.stop(); if (saved === undefined) delete process.env.APIPLAN_USAGE_LEDGER; else process.env.APIPLAN_USAGE_LEDGER = saved; }
  });
});

describe("apiplan keys label (CLI)", () => {
  test("relabels by id and prints old → new; usage errors exit nonzero", () => {
    const file = join(DIR, "f", "keys.json");
    const { record } = createKey("mag9", file);
    const run = (...a: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "bin/apiplan.ts"), "keys", ...a, "--keys-file", file], { env: { ...process.env, NO_COLOR: "1" } });
    const ok = run("label", record.id, "Noa", "Levi");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("mag9");
    expect(ok.stdout.toString()).toContain("Noa Levi");
    expect(readStore(file).keys[0].label).toBe("Noa Levi");
    expect(run("label", record.id).exitCode).not.toBe(0);
    expect(run("label", "nope0000", "x").exitCode).not.toBe(0);
  });
});
