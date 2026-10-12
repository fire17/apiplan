#!/usr/bin/env bun
// catalog-daily.ts — once a day: what changed at the providers, and are the harnesses behind?
//
// REPORT ONLY. Nothing here installs, updates or rewrites the live catalog.
//
//   bun scripts/catalog-daily.ts            write reports/catalog/YYYY-MM-DD.md (+ .json)
//                                           and append one line to ~/.livemind/catalog-daily.jsonl
//   bun scripts/catalog-daily.ts --stdout   also print the report
//
// WHY A SHADOW STATE DIR. `apiplan models --refresh` rewrites ~/.apiplan/models.*.json, and a
// rewritten cache changes what every alias resolves to (opus, gpt, gemini…) on a machine where
// apiplan serve, the shims and the MIND are all live. A daily job must never move those under
// anyone's feet. So the real refresh code runs in a child process with APIPLAN_HOME pointed at
// an empty temp dir: every provider's live list lands THERE, gets diffed against the live
// caches, and the temp dir is deleted. Credentials do not live in the state dir (Keychain,
// ~/.codex, ~/.claude, the Antigravity token well), so the child reads the same logins.
//
// Launchd: com.fire17.apiplan-catalog-daily (09:30 local) — see scripts/com.fire17.apiplan-catalog-daily.plist.
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = dirname(import.meta.dir);                     // ~/Creations/APIPlan
const HOME = homedir();
const LIVE_STATE = process.env.APIPLAN_HOME || join(HOME, ".apiplan");
const REPORT_DIR = process.env.APIPLAN_CATALOG_REPORT_DIR || join(ROOT, "reports", "catalog");
const LEDGER = process.env.APIPLAN_CATALOG_LEDGER || join(HOME, ".livemind", "catalog-daily.jsonl");
const PROVIDERS = ["anthropic", "openai", "google", "ollama", "grok", "gemini", "zen", "online"] as const;
type P = (typeof PROVIDERS)[number];
type Entry = { id: string; label?: string; efforts?: string[]; contextWindow?: number; maxContextWindow?: number };

// Local date, not UTC: the report for "today" in Israel at 09:30 is today's.
const now = new Date();
const DATE = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Never let a token into a report: error bodies can echo headers. */
const redact = (s: string) => s
  .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
  .replace(/\b(sk-|sk_|ya29\.|AIza|eyJ)[A-Za-z0-9._~+/=-]{8,}/g, "[redacted]")
  .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
const plain = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");

function sh(cmd: string[], timeoutMs = 30_000, env?: Record<string, string>): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1", ...env } as any });
    const out = (r.stdout.toString() + (r.exitCode ? r.stderr.toString() : "")).trim();
    return { ok: r.exitCode === 0, out };
  } catch (e: any) { return { ok: false, out: String(e?.message ?? e) }; }
}
const readCache = (dir: string, p: P): { fetched_at?: number; models: Entry[] } | null => {
  const f = join(dir, `models.${p}.json`);
  if (!existsSync(f)) return null;
  try { const j = JSON.parse(readFileSync(f, "utf8")); return { fetched_at: j.fetched_at, models: Array.isArray(j.models) ? j.models : [] }; } catch { return null; }
};

// ── 1. live catalogs, fetched into a shadow state dir ─────────────────────────────────────────
type ProvDiff = { provider: P; status: "checked" | "not-checked"; why?: string; liveCount?: number; registryCount?: number;
  registrySource?: string; new: string[]; gone: string[]; changed: { id: string; what: string[] }[]; unaddressable: string[]; notInBaked: string[] };

const shadow = mkdtempSync(join(tmpdir(), "apiplan-catalog-"));
let refreshNotes: string[] = [];
let diffs: ProvDiff[] = [];
try {
  const r = sh([process.execPath, join(ROOT, "bin", "apiplan.ts"), "models", "--refresh"], 240_000, { APIPLAN_HOME: shadow });
  refreshNotes = plain(r.out).split("\n").map((l) => l.trim()).filter((l) => /^[a-z]+: /.test(l)).map(redact);
  if (!refreshNotes.length) refreshNotes = [`refresh produced no provider notes (exit ${r.ok ? 0 : "≠0"}): ${redact(plain(r.out)).slice(0, 300)}`];

  // The registry module, read-only, in TWO views: the live state dir (what resolves today, for
  // the parser check) and an empty one (the baked snapshot that ships in src/registry.ts).
  const empty = mkdtempSync(join(tmpdir(), "apiplan-baked-"));
  process.env.APIPLAN_HOME = empty;
  const R = await import(join(ROOT, "src", "registry.ts"));
  const baked = new Map<P, Set<string>>(PROVIDERS.map((p) => [p, new Set<string>((R.models(p) as any[]).map((m) => m.id))]));
  rmSync(empty, { recursive: true, force: true });

  const sig = (e: Entry) => ({ label: e.label ?? "", efforts: [...(e.efforts ?? [])].sort().join(","), ctx: String(e.contextWindow ?? ""), maxctx: String(e.maxContextWindow ?? "") });
  for (const p of PROVIDERS) {
    const note = refreshNotes.find((n) => n.startsWith(`${p}:`)) ?? "";
    const fresh = readCache(shadow, p);
    const base: ProvDiff = { provider: p, status: "not-checked", new: [], gone: [], changed: [], unaddressable: [], notInBaked: [] };
    if (!fresh) { diffs.push({ ...base, why: note.replace(`${p}: `, "") || "no list written" }); continue; }
    const live = readCache(LIVE_STATE, p);
    const reg = live?.models.length ? live.models : null;
    const regIds = new Map((reg ?? []).map((e) => [e.id, e]));
    const freshIds = new Map(fresh.models.map((e) => [e.id, e]));
    const d: ProvDiff = { ...base, status: "checked", liveCount: freshIds.size, registryCount: reg ? regIds.size : baked.get(p)!.size,
      registrySource: reg ? `~/.apiplan/models.${p}.json (fetched ${live?.fetched_at ? new Date(live.fetched_at).toISOString().slice(0, 16).replace("T", " ") + "Z" : "?"})` : "baked snapshot (no live cache)" };
    const compare = reg ? regIds : new Map([...baked.get(p)!].map((id) => [id, { id } as Entry]));
    for (const id of freshIds.keys()) if (!compare.has(id)) d.new.push(id);
    for (const id of compare.keys()) if (!freshIds.has(id)) d.gone.push(id);
    if (reg) for (const [id, e] of freshIds) {
      const o = regIds.get(id); if (!o) continue;
      const a = sig(o), b = sig(e);
      const what = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] || "∅"} → ${b[k] || "∅"}`);
      if (what.length) d.changed.push({ id, what });
    }
    d.unaddressable = R.unparseable(p, fresh.models);
    // google's ids are folded (gemini-3.8-flash-high → gemini-3.8-flash) by the parser; compare
    // parsed ids so the baked check is apples to apples.
    const parsedIds = fresh.models.map((e) => (p === "google" ? (e.id.match(/^(gemini-[\d.]+-(?:flash|pro))(?:-(?:low|medium|high))?$/)?.[1] ?? e.id) : e.id));
    d.notInBaked = p === "ollama" ? [] : [...new Set(parsedIds)].filter((id) => !baked.get(p)!.has(id) && !d.unaddressable.includes(id));
    diffs.push(d);
  }
} finally {
  rmSync(shadow, { recursive: true, force: true });            // the shadow never outlives the run
}

// ── 2. harness versions ───────────────────────────────────────────────────────────────────────
const semver = (s: string) => s.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number) ?? null;
const lt = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const npmLatest = (pkg: string) => { const r = sh(["npm", "view", pkg, "version"], 45_000); return r.ok && semver(r.out) ? r.out.trim() : null; };
type Harness = { name: string; bin: string; installed: string | null; latest: string | null; update: "yes" | "no" | "unknown"; how: string; note?: string };
const latestClaude = npmLatest("@anthropic-ai/claude-code");
const latestCodex = npmLatest("@openai/codex");
const caskClaude = (() => { const r = sh(["brew", "info", "--json=v2", "--cask", "claude-code"], 45_000); try { return JSON.parse(r.out).casks?.[0]?.version ?? null; } catch { return null; } })();

function harness(name: string, bin: string, latest: string | null, how: string, note?: string): Harness {
  const r = sh([bin, "--version"], 20_000);
  const v = r.ok ? semver(r.out)?.join(".") ?? null : null;
  const L = latest ? semver(latest) : null;
  const update = v && L ? (lt(semver(v)!, L) < 0 ? "yes" : "no") : "unknown";
  return { name, bin: bin.replace(HOME, "~"), installed: v, latest, update, how, note };
}
const harnesses: Harness[] = [];
const seen = new Set<string>();
const which = sh(["/usr/bin/which", "-a", "claude"]).out.split("\n").filter(Boolean);
for (const b of [...which, join(HOME, ".bun/bin/claude"), "/opt/homebrew/bin/claude"]) {
  if (!existsSync(b)) continue;
  let real = b; try { real = realpathSync(b); } catch {}
  if (seen.has(real)) continue; seen.add(real);
  const how = real.includes("/.bun/") ? "bun add -g @anthropic-ai/claude-code@latest" : real.includes("/homebrew/lib/node_modules/") ? "npm i -g @anthropic-ai/claude-code@latest" : "claude update";
  harnesses.push(harness(`Claude Code (${which[0] === b ? "PATH" : "also installed"})`, b, latestClaude, how));
}
const ucode = join(HOME, ".ucode", "bin", "claude");
if (existsSync(ucode)) harnesses.push(harness("ucode (unleashed Claude Code)", ucode, latestClaude, "re-forge: clone the updated stock binary into ~/.ucode/bin/claude, then re-patch (see ~/.ucode)", "patched clone — never a plain upgrade"));
const codexBin = sh(["/usr/bin/which", "codex"]).out.split("\n")[0];
if (codexBin) harnesses.push(harness("Codex CLI", codexBin, latestCodex, codexBin.includes("/.bun/") ? "bun add -g @openai/codex@latest" : "npm i -g @openai/codex@latest"));
else harnesses.push({ name: "Codex CLI", bin: "(not on PATH)", installed: null, latest: latestCodex, update: "unknown", how: "npm i -g @openai/codex" });

// ── 3. report ─────────────────────────────────────────────────────────────────────────────────
const checked = diffs.filter((d) => d.status === "checked");
const totals = { new: checked.reduce((n, d) => n + d.new.length, 0), gone: checked.reduce((n, d) => n + d.gone.length, 0), changed: checked.reduce((n, d) => n + d.changed.length, 0) };
const unaddr = checked.flatMap((d) => d.unaddressable.map((id) => `${d.provider}:${id}`));
const needBake = checked.flatMap((d) => d.notInBaked.map((id) => `${d.provider}:${id}`));
const updates = harnesses.filter((h) => h.update === "yes");
const list = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "—");

const L: string[] = [];
L.push(`# Model catalog + harness check — ${DATE}`, "");
L.push(`> Generated ${now.toISOString()} by \`scripts/catalog-daily.ts\`. **Report only**: nothing was installed, updated, or written to the live catalog (\`~/.apiplan\`). Live lists were fetched into a throwaway state dir and diffed.`, "");
L.push("## Summary", "");
L.push(`- Catalog: **${totals.new} NEW · ${totals.gone} GONE · ${totals.changed} CHANGED** across ${checked.length}/${PROVIDERS.length} providers checked.`);
L.push(`- Harness updates available: **${updates.length ? "YES — " + updates.map((h) => `${h.name} ${h.installed} → ${h.latest}`).join("; ") : "no"}**. Do not update without Tami's approval.`);
if (unaddr.length) L.push(`- Needs code (parser cannot address): ${list(unaddr)} — see ADD-A-MODEL.md step 3.`);
if (needBake.length) L.push(`- Live but not in the baked snapshot (src/registry.ts FALLBACK): ${list(needBake)}`);
L.push("", "## Providers", "", "| provider | status | live | registry | NEW | GONE | CHANGED |", "|---|---|---|---|---|---|---|");
for (const d of diffs) L.push(d.status === "checked"
  ? `| ${d.provider} | checked | ${d.liveCount} | ${d.registryCount} | ${d.new.length} | ${d.gone.length} | ${d.changed.length} |`
  : `| ${d.provider} | not checked — ${d.why?.replace(/\|/g, "/")} | | | | | |`);
for (const d of checked) {
  if (!d.new.length && !d.gone.length && !d.changed.length && !d.unaddressable.length) continue;
  L.push("", `### ${d.provider}`, "", `Compared against ${d.registrySource}.`, "");
  if (d.new.length) L.push(`- NEW: ${list(d.new)}`);
  if (d.gone.length) L.push(`- GONE: ${list(d.gone)}`);
  for (const c of d.changed) L.push(`- CHANGED \`${c.id}\`: ${c.what.join("; ")}`);
  if (d.unaddressable.length) L.push(`- unaddressable (parser drops): ${list(d.unaddressable)}`);
}
L.push("", "## Harnesses", "", "| harness | binary | installed | latest | UPDATE AVAILABLE | how (do NOT run without approval) |", "|---|---|---|---|---|---|");
for (const h of harnesses) L.push(`| ${h.name} | \`${h.bin}\` | ${h.installed ?? "?"} | ${h.latest ?? "?"} | ${h.update}${h.note ? ` (${h.note})` : ""} | \`${h.how}\` |`);
if (caskClaude) L.push("", `Homebrew cask \`claude-code\` latest: ${caskClaude} (informational — npm is the reference).`);
L.push("", "## Raw refresh notes", "", "```", ...refreshNotes, "```", "");
L.push("To act on a NEW model: ADD-A-MODEL.md. To make it resolve locally: `apiplan models --refresh --provider <p>` then run the suite (a refresh moves alias resolution).", "");
const report = L.join("\n");

mkdirSync(REPORT_DIR, { recursive: true });
const mdPath = join(REPORT_DIR, `${DATE}.md`);
writeFileSync(mdPath, report);
writeFileSync(join(REPORT_DIR, `${DATE}.json`), JSON.stringify({ date: DATE, generated: now.toISOString(), totals, diffs, harnesses, caskClaude, refreshNotes }, null, 2));
mkdirSync(dirname(LEDGER), { recursive: true });
const line = { ts: now.toISOString(), date: DATE, new: totals.new, gone: totals.gone, changed: totals.changed, checked: checked.length,
  unaddressable: unaddr.length, harness_update: updates.length > 0, updates: updates.map((h) => `${h.name} ${h.installed}->${h.latest}`), report: mdPath,
  summary: `catalog ${totals.new} new/${totals.gone} gone/${totals.changed} changed (${checked.length}/${PROVIDERS.length} providers); harness update ${updates.length ? "AVAILABLE: " + updates.map((h) => `${h.name} ${h.installed}->${h.latest}`).join(", ") : "none"}` };
appendFileSync(LEDGER, JSON.stringify(line) + "\n");

if (process.argv.includes("--stdout")) process.stdout.write(report + "\n");
process.stdout.write(`${line.summary}\nreport: ${mdPath}\n`);
