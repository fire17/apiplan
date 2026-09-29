// GPT-6 Sol + Luna (2026-09-29): the registry half of "every GPT-6 model the subscription serves".
//
// The live Codex catalog hides every model whose `minimal_client_version` is above the version the
// client asks as: gpt-6-sol and gpt-6-luna need 0.155.0 (observed 2026-09-29 — absent at 0.153.4 and
// 0.154.9, listed from 0.155.0 up to 99.0.0), gpt-6-astra 0.153.0. The fixture below is that catalog
// (0.155.0 read, raw scratchpad gpt6/catalog-raw-0.155.0.json) with only the fields apiplan reads.
//
// Home-dependent cases run in a SUBPROCESS: registry.ts binds STATE_DIR from APIPLAN_HOME at import,
// so an in-process test would read the user's own ~/.apiplan cache (the machine-state trap the
// existing registry/astra pins fall into — "Live catalog refresh moves tests", 2026-09-12).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CLIENT_VERSION_FLOOR, CODEX_CATALOG_PROBE_VERSION, fromCodexCatalog, neededClientVersion, acceptsImages,
} from "../src/registry.ts";

const REPO = join(import.meta.dir, "..");
const lv = (...e: string[]) => e.map((effort) => ({ effort, description: "" }));
const row = (slug: string, display: string, min: string, priority: number, def: string, efforts: string[], max = 872000) => ({
  slug, display_name: display, minimal_client_version: min, priority, default_reasoning_level: def,
  supported_reasoning_levels: lv(...efforts), context_window: 272000, max_context_window: max,
  input_modalities: ["text", "image"], supported_in_api: true, visibility: "list",
});
const MAXU = ["low", "medium", "high", "xhigh", "max", "ultra"], MAX = ["low", "medium", "high", "xhigh", "max"];
/** Codex catalog as client 0.155.0, 2026-09-29, in the server's own order. */
export const CATALOG_0155 = {
  models: [
    row("gpt-6-astra", "GPT-6-Astra", "0.153.0", 1, "medium", MAXU),
    row("gpt-6-sol", "GPT-6-Sol", "0.155.0", 2, "low", MAXU),
    row("gpt-6-luna", "GPT-6-Luna", "0.155.0", 3, "medium", MAX),
    { ...row("gpt-reserve", "GPT-Reserve", "0.144.0", 3, "medium", MAX), visibility: "hide" },
    row("gpt-5.6-sol", "GPT-5.6-Sol", "0.144.0", 4, "low", MAXU),
    row("gpt-5.6-terra", "GPT-5.6-Terra", "0.144.0", 7, "medium", MAXU),
    row("gpt-5.6-luna", "GPT-5.6-Luna", "0.144.0", 8, "medium", MAX),
    row("gpt-5.5", "GPT-5.5", "0.124.0", 12, "medium", ["low", "medium", "high", "xhigh"], 272000),
    { ...row("codex-auto-review", "Codex Auto Review", "0.98.0", 43, "medium", MAX), visibility: "hide" },
  ],
};

type Probe = { resolve: Record<string, string | null>; openai: any[]; roundTrip: string[]; err?: string };
const NAMES = ["luna", "sol", "astra", "terra", "gpt", "gpt6", "codex", "gpt56", "luna6", "sol6", "astra6",
  "luna56", "sol56", "terra56", "gpt6luna", "gpt6sol", "gpt56luna", "gpt56sol", "gpt-6-luna", "GPT-6-Luna",
  "gpt-6-sol", "spark13", "gpt-6-terra", "terra6"];
/** Run the registry against `cache` (null = no models.openai.json → FALLBACK) in a hermetic home. */
function probe(cache: any[] | null): Probe {
  const home = mkdtempSync(join(tmpdir(), "apiplan-gpt6-"));
  if (cache) writeFileSync(join(home, "models.openai.json"), JSON.stringify({ fetched_at: Date.now(), models: cache }));
  const code = `
    const R = await import(${JSON.stringify(join(REPO, "src/registry.ts"))});
    const out = { resolve: {}, openai: [] };
    for (const n of ${JSON.stringify(NAMES)}) out.resolve[n] = R.resolve(n)?.id ?? null;
    for (const m of R.models("openai")) out.openai.push({ id: m.id, aliases: R.aliasesFor(m), efforts: m.efforts, input: m.input,
      images: R.acceptsImages(m), ctx: m.contextWindow, max: m.maxContextWindow, def: m.defaultEffort, rank: m.rank });
    out.roundTrip = R.models().flatMap((m) => R.aliasesFor(m).filter((a) => R.resolve(a)?.id !== m.id).map((a) => a + "!->" + m.id));
    process.stdout.write(JSON.stringify(out));`;
  const r = Bun.spawnSync(["bun", "-e", code], { cwd: REPO, env: { ...process.env, APIPLAN_HOME: home, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString();
  if (r.exitCode !== 0 || !text) throw new Error(`probe failed (${r.exitCode}): ${r.stderr.toString().slice(0, 800)}`);
  return JSON.parse(text);
}
const rowOf = (p: Probe, id: string) => p.openai.find((m) => m.id === id);

describe("catalog client version", () => {
  test("the floor is the lowest version that lists every model known today (0.155.0)", () => {
    expect(CODEX_CLIENT_VERSION_FLOOR).toBe("0.155.0");
    expect(CODEX_CATALOG_PROBE_VERSION).toBe("99.0.0");
  });
  test("neededClientVersion = highest minimal_client_version among API-capable rows", () => {
    expect(neededClientVersion(CATALOG_0155)).toBe("0.155.0");
    // a future model raises it with no code edit
    expect(neededClientVersion({ models: [...CATALOG_0155.models, row("gpt-6-terra", "GPT-6-Terra", "0.170.0", 5, "medium", MAX)] })).toBe("0.170.0");
    // numeric, not lexical
    expect(neededClientVersion({ models: [row("a", "A", "0.99.0", 1, "low", MAX), row("b", "B", "0.155.0", 2, "low", MAX)] })).toBe("0.155.0");
    // a row the API cannot use does not raise it; junk is ignored; nothing stated → null
    expect(neededClientVersion({ models: [row("a", "A", "0.155.0", 1, "low", MAX), { ...row("b", "B", "9.0.0", 2, "low", MAX), supported_in_api: false }, { slug: "c", minimal_client_version: "junk" }] })).toBe("0.155.0");
    expect(neededClientVersion({ models: [] })).toBeNull();
    expect(neededClientVersion(null)).toBeNull();
  });
});

describe("fromCodexCatalog carries every field the registry uses", () => {
  const list = fromCodexCatalog(CATALOG_0155);
  test("gpt-6-luna", () => {
    expect(list.find((m) => m.id === "gpt-6-luna")).toEqual({
      id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 272000,
      maxContextWindow: 872000, input: ["text", "image"], defaultEffort: "medium", rank: 3,
    });
  });
  test("ultra (a Codex CLI delegation mode, a 400 on the wire) is dropped", () => {
    for (const m of list) expect(m.efforts).not.toContain("ultra");
    expect(list.map((m) => m.id)).toEqual(CATALOG_0155.models.map((m) => m.slug));
  });
  test("rows the API cannot serve, and rows without a slug, are dropped", () => {
    expect(fromCodexCatalog({ models: [{ ...row("x", "X", "0.1.0", 1, "low", MAX), supported_in_api: false }, { display_name: "no slug" }, row("y", "Y", "0.1.0", 2, "low", MAX)] }).map((m) => m.id)).toEqual(["y"]);
  });
});

describe("acceptsImages is tri-state", () => {
  test("true / false / null (unknown — the caller keeps its own rule)", () => {
    expect(acceptsImages({ input: ["text", "image"] })).toBe(true);
    expect(acceptsImages({ input: ["text"] })).toBe(false);
    expect(acceptsImages({})).toBeNull();
  });
});

describe("registry with the 0.155.0 catalog cached", () => {
  let p: Probe;
  beforeAll(() => { p = probe(fromCodexCatalog(CATALOG_0155)); });

  test("family / variant words follow the NEWEST model carrying them", () => {
    expect(p.resolve.luna).toBe("gpt-6-luna");
    expect(p.resolve.sol).toBe("gpt-6-sol");
    expect(p.resolve.astra).toBe("gpt-6-astra");
    expect(p.resolve.terra).toBe("gpt-5.6-terra"); // there is no gpt-6-terra at any client version
    expect(p.resolve["gpt-6-terra"]).toBeNull();
    expect(p.resolve.terra6).toBeNull();
  });
  test("explicit names reach both generations", () => {
    for (const [n, want] of [["luna6", "gpt-6-luna"], ["sol6", "gpt-6-sol"], ["astra6", "gpt-6-astra"], ["gpt6luna", "gpt-6-luna"],
      ["gpt6sol", "gpt-6-sol"], ["gpt-6-luna", "gpt-6-luna"], ["GPT-6-Luna", "gpt-6-luna"], ["gpt-6-sol", "gpt-6-sol"],
      ["luna56", "gpt-5.6-luna"], ["sol56", "gpt-5.6-sol"], ["terra56", "gpt-5.6-terra"], ["gpt56luna", "gpt-5.6-luna"], ["gpt56sol", "gpt-5.6-sol"]])
      expect([n, p.resolve[n]]).toEqual([n, want]);
  });
  test("flagship words stay on GPT-6-Astra; gpt56 on the 5.6 flagship", () => {
    expect(p.resolve.gpt).toBe("gpt-6-astra");
    expect(p.resolve.gpt6).toBe("gpt-6-astra");
    expect(p.resolve.codex).toBe("gpt-6-astra");
    expect(p.resolve.gpt56).toBe("gpt-5.6-sol");
  });
  test("none only where the wire takes it (400 receipts, 2026-09-29)", () => {
    expect(rowOf(p, "gpt-6-luna").efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(rowOf(p, "gpt-6-sol").efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(rowOf(p, "gpt-6-astra").efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(rowOf(p, "gpt-5.6-luna").efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  test("catalog facts are carried per model", () => {
    expect(rowOf(p, "gpt-6-luna")).toMatchObject({ ctx: 272000, max: 872000, input: ["text", "image"], images: true, def: "medium", rank: 3 });
    expect(rowOf(p, "gpt-6-sol")).toMatchObject({ ctx: 272000, max: 872000, images: true, def: "low", rank: 2 });
    expect(rowOf(p, "gpt-6-astra")).toMatchObject({ images: true, def: "medium", rank: 1 });
  });
  test("aliases are honest: every listed alias resolves back to its own row", () => {
    expect(p.roundTrip).toEqual([]);
    expect(rowOf(p, "gpt-6-luna").aliases).toEqual(["gpt6luna", "luna", "luna6"]);
    expect(rowOf(p, "gpt-6-sol").aliases).toEqual(["gpt6sol", "sol", "sol6"]);
    expect(rowOf(p, "gpt-6-astra").aliases).toEqual(["gpt", "gpt6astra", "astra"]); // astra6 resolves, not advertised: one generation
    expect(rowOf(p, "gpt-5.6-luna").aliases).toEqual(["gpt56luna", "luna56"]);
    expect(rowOf(p, "gpt-5.6-terra").aliases).toEqual(["gpt56terra", "terra"]);
  });
  test("variant+version is OpenAI-only: zen copies and other vendors mint no new words", () => {
    expect(p.resolve.spark13).toBeNull();
  });
});

describe("robustness", () => {
  test("catalog priority, not list order, keeps gpt/gpt6/codex on the flagship", () => {
    const p = probe(fromCodexCatalog({ models: [...CATALOG_0155.models].reverse() }));
    expect([p.resolve.gpt, p.resolve.gpt6, p.resolve.codex]).toEqual(["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
    expect(p.resolve.luna).toBe("gpt-6-luna");
  });
  test("a cache in the pre-2026-09-29 shape (id/label/efforts/contextWindow only) still resolves GPT-6", () => {
    const slim = fromCodexCatalog(CATALOG_0155).map(({ id, label, efforts, contextWindow }) => ({ id, label, efforts, contextWindow }));
    const p = probe(slim);
    expect([p.resolve.luna, p.resolve.luna6, p.resolve.sol, p.resolve.gpt]).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]);
    expect(rowOf(p, "gpt-6-luna").efforts[0]).toBe("none");
    expect(rowOf(p, "gpt-6-luna").images).toBeNull(); // not stated → unknown, never invented
  });
  test("today's stale cache (astra only) keeps working unchanged", () => {
    const p = probe([
      { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: MAX, contextWindow: 272000 },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: MAX, contextWindow: 272000 },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: MAX, contextWindow: 272000 },
    ]);
    expect([p.resolve.luna, p.resolve.sol, p.resolve.gpt, p.resolve.luna56, p.resolve.luna6]).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna", null]);
    expect(p.roundTrip).toEqual([]);
  });
  test("a fresh machine with no cache (FALLBACK) already knows GPT-6 Sol and Luna", () => {
    const p = probe(null);
    expect([p.resolve.luna, p.resolve.sol, p.resolve.luna6, p.resolve.sol56, p.resolve.gpt]).toEqual(["gpt-6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-astra"]);
    expect(rowOf(p, "gpt-6-luna")).toMatchObject({ ctx: 272000, max: 872000, images: true, def: "medium" });
    expect(rowOf(p, "gpt-6-luna").efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(p.roundTrip).toEqual([]);
  });
});
