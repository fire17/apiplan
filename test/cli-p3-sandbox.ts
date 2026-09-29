// cli-p3-sandbox.ts — hermetic sandbox for the P3 CLI tests (commands / completions / doctor).
// Isolated HOME + APIPLAN_HOME + APIPLAN_BIN per box; fixtures are inline so nothing outside
// this file is needed. Module-level STATE_DIR is fixed at import, so every probe is a subprocess.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

export const ROOT = join(import.meta.dir, "..");
export const ASK = join(ROOT, "bin", "ask.ts"), AP = join(ROOT, "bin", "apiplan.ts");

/** ~/.apiplan/models.openai.json as fetched at client 0.200.0 (GPT-6 Astra, Sol, Luna listed). */
export const CACHE_GPT6 = {"fetched_at": 1790000000000, "models": [{"id": "gpt-6-astra", "label": "GPT-6-Astra", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-6-sol", "label": "GPT-6-Sol", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-6-luna", "label": "GPT-6-Luna", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-reserve", "label": "GPT-Reserve", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-terra", "label": "GPT-5.6-Terra", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-luna", "label": "GPT-5.6-Luna", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "medium", "high", "xhigh"], "contextWindow": 272000}, {"id": "codex-auto-review", "label": "Codex Auto Review", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}]};
/** The real cache as of 2026-09-15 (fetched below 0.155.0: no GPT-6 Sol/Luna). */
export const CACHE_2026_09_15 = {"fetched_at": 1789470482622, "models": [{"id": "gpt-6-astra", "label": "GPT-6-Astra", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-reserve", "label": "GPT-Reserve", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-terra", "label": "GPT-5.6-Terra", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.6-luna", "label": "GPT-5.6-Luna", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}, {"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "medium", "high", "xhigh"], "contextWindow": 272000}, {"id": "codex-auto-review", "label": "Codex Auto Review", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": 272000}]};
/** Trimmed raw Codex catalog (live, 2026-09-29) — the stub filters it by minimal_client_version. */
export const CODEX_CATALOG = {"models": [{"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"}], "context_window": 272000, "minimal_client_version": "0.153.0", "priority": 1, "visibility": "list"}, {"slug": "gpt-6-sol", "display_name": "GPT-6-Sol", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"}], "context_window": 272000, "minimal_client_version": "0.155.0", "priority": 2, "visibility": "list"}, {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}], "context_window": 272000, "minimal_client_version": "0.155.0", "priority": 3, "visibility": "list"}, {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}], "context_window": 272000, "minimal_client_version": "0.144.0", "priority": 3, "visibility": "hide"}, {"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"}], "context_window": 272000, "minimal_client_version": "0.144.0", "priority": 4, "visibility": "list"}, {"slug": "gpt-5.6-terra", "display_name": "GPT-5.6-Terra", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"}], "context_window": 272000, "minimal_client_version": "0.144.0", "priority": 7, "visibility": "list"}, {"slug": "gpt-5.6-luna", "display_name": "GPT-5.6-Luna", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}], "context_window": 272000, "minimal_client_version": "0.144.0", "priority": 8, "visibility": "list"}, {"slug": "gpt-5.5", "display_name": "GPT-5.5", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}], "context_window": 272000, "minimal_client_version": "0.124.0", "priority": 12, "visibility": "list"}, {"slug": "codex-auto-review", "display_name": "Codex Auto Review", "supported_in_api": true, "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}, {"effort": "xhigh"}, {"effort": "max"}], "context_window": 272000, "minimal_client_version": "0.98.0", "priority": 43, "visibility": "hide"}]};

export type Run = { out: string; err: string; code: number };
export type Box = { dir: string; home: string; state: string; bin: string; env: Record<string, string>;
  run(entry: string, args: string[], env?: Record<string, string>): Run };

export function sandbox(opts: { catalog?: "gpt6" | "2026-09-15" | null; commands?: object[]; meta?: object } = {}): Box {
  const dir = mkdtempSync(join(tmpdir(), "apiplan-p3-"));
  const home = join(dir, "home"), state = join(dir, "state"), bin = join(dir, "bin");
  for (const d of [home, state, bin, join(home, ".codex")]) mkdirSync(d, { recursive: true });
  const cat = opts.catalog === undefined ? "gpt6" : opts.catalog;
  if (cat) writeFileSync(join(state, "models.openai.json"), JSON.stringify(cat === "gpt6" ? CACHE_GPT6 : CACHE_2026_09_15));
  if (opts.commands) writeFileSync(join(state, "commands.json"), JSON.stringify({ version: 1, commands: opts.commands }, null, 2));
  if (opts.meta) writeFileSync(join(state, "models.openai.meta.json"), JSON.stringify(opts.meta));
  const auth = join(dir, "codex-auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "AT-p3", refresh_token: "RT-p3", account_id: "acct-p3" }, last_refresh: new Date().toISOString() }));
  const env = { ...process.env, HOME: home, APIPLAN_HOME: state, APIPLAN_BIN: bin, APIPLAN_CODEX_AUTH: auth,
    APIPLAN_DAEMON: "off", NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` } as Record<string, string>;
  delete env.APIPLAN_CODEX_CLIENT_VERSION;
  const run = (entry: string, args: string[], extra: Record<string, string> = {}): Run => {
    const p = Bun.spawnSync([process.execPath, entry, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode ?? -1 };
  };
  return { dir, home, state, bin, env, run };
}

/** A real RGB PNG: `pixel(x, y)` → [r, g, b]. Used for `-i` (the engine refuses < 8×8). */
export function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const raw = new Uint8Array(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (1 + 3 * w) + 1 + 3 * x);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { total.set(p, o); o += p.length; }
  return total;
}
/** Red circle left, blue square right, white ground — 96×64, the live-proof image. */
export const shapesPng = () => png(96, 64, (x, y) =>
  (x - 24) ** 2 + (y - 32) ** 2 <= 14 ** 2 ? [220, 30, 30] : x >= 58 && x < 86 && y >= 18 && y < 46 ? [30, 60, 220] : [255, 255, 255]);
