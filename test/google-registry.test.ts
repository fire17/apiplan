// Gemini 3.8 Flash (2026-09-30): the live Antigravity catalog (fetchAvailableModels) serves
// gemini-3.8-flash-{low,medium,high} and names gemini-3.8-flash-high its defaultAgentModelId.
// The offline FALLBACK must carry it too, so `gemini` means the newest gemini on a fresh
// machine before the first `apiplan models --refresh`.
//
// Runs in a SUBPROCESS with a hermetic APIPLAN_HOME: registry.ts binds STATE_DIR at import,
// so an in-process test would read the user's own ~/.apiplan cache.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const NAMES = ["gemini", "flash", "gemini38flash", "gemini38", "gemini-3.8-flash", "gemini37flash", "gemini31pro", "pro"];
/** Live catalog 2026-09-30, grouped the way refreshGoogleCatalog saves it (its own order). */
const LIVE_0930 = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: ["low", "medium", "high"] },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", efforts: ["low"] },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: ["low", "medium", "high"] },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", efforts: ["low", "high"] },
];

function probe(cache: any[] | null) {
  const home = mkdtempSync(join(tmpdir(), "apiplan-gemini-"));
  if (cache) writeFileSync(join(home, "models.google.json"), JSON.stringify({ fetched_at: Date.now(), models: cache }));
  const code = `
    const R = await import(${JSON.stringify(join(REPO, "src/registry.ts"))});
    const out = { resolve: {}, google: [], roundTrip: [] };
    for (const n of ${JSON.stringify(NAMES)}) out.resolve[n] = R.resolve(n)?.id ?? null;
    for (const m of R.models("google")) out.google.push({ id: m.id, aliases: R.aliasesFor(m), efforts: m.efforts });
    out.roundTrip = R.models("google").flatMap((m) => R.aliasesFor(m).filter((a) => R.resolve(a)?.id !== m.id && a !== "flash").map((a) => a + "!->" + m.id));
    process.stdout.write(JSON.stringify(out));`;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: REPO, env: { ...process.env, APIPLAN_HOME: home, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString();
  if (r.exitCode !== 0 || !text) throw new Error(`probe failed (${r.exitCode}): ${r.stderr.toString().slice(0, 800)}`);
  return JSON.parse(text) as { resolve: Record<string, string | null>; google: { id: string; aliases: string[]; efforts: string[] }[]; roundTrip: string[] };
}

for (const [name, cache] of [["offline FALLBACK", null], ["live catalog 2026-09-30", LIVE_0930]] as const) {
  describe(`gemini 3.8 flash — ${name}`, () => {
    const p = probe(cache as any);
    test("gemini and flash mean 3.8; older versions stay reachable", () => {
      expect(p.resolve.gemini).toBe("gemini-3.8-flash");
      expect(p.resolve.flash).toBe("gemini-3.8-flash");
      expect(p.resolve.gemini38flash).toBe("gemini-3.8-flash");
      expect(p.resolve.gemini38).toBe("gemini-3.8-flash");
      expect(p.resolve["gemini-3.8-flash"]).toBe("gemini-3.8-flash");
      expect(p.resolve.gemini37flash).toBe("gemini-3.7-flash");
      expect(p.resolve.gemini31pro).toBe("gemini-3.1-pro");
      expect(p.resolve.pro).toBe("gemini-3.1-pro");
    });
    test("3.8 lists first with all three efforts and every printed alias round-trips", () => {
      expect(p.google[0]).toEqual({ id: "gemini-3.8-flash", aliases: ["gemini", "gemini38flash", "flash"], efforts: ["low", "medium", "high"] });
      expect(p.roundTrip).toEqual([]);
    });
  });
}
