#!/usr/bin/env bun
// apiplan.ts — the control surface: which providers am I connected to, which
// models can I call, and which commands exist on my PATH.
//
// Every capability is a headless subcommand first; the TUI is a view over those
// same functions, so anything you can click you can also script.
import { join, basename as basenameOf } from "node:path";
import { PROVIDERS, providerFor, refreshGoogleCatalog } from "../src/providers.ts";
import { models, aliasesFor, cacheAge, cacheStale, saveModels, resolve, unparseable, type Model, type ProviderId } from "../src/registry.ts";
import * as C from "../src/commands.ts";
import * as R from "../src/registry.ts";
import { osLabel, onPath, defaultBinDir, whichSync, IS_WIN, STATE_DIR, HOME, readJson, writeJson } from "../src/platform.ts";
import { OLLAMA_BASE, OLLAMA_META_FILE, refreshOllama } from "../src/providers-ollama.ts";
import { refreshZenCatalog, zenModelsFile } from "../src/providers-zen.ts";
import { VERSION, daemonAlive, daemonStop, runDaemon, die } from "../src/engine.ts";
import { rosterYaml, applyRoster } from "../src/roster.ts";
import { LIVE_MODELS, DEFAULT_LIVE_MODEL, resolveLiveModel, requireLiveCapability, liveModelArgument } from "../src/live-models.ts";

// ── presentation ──────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (c: string) => (s: string | number) => (tty ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const dim = sgr("2"), bold = sgr("1"), ul = sgr("4");
const ok = sgr("38;2;120;200;140"), bad = sgr("38;2;225;110;95"), warn = sgr("38;2;225;185;95");
const key = sgr("38;2;150;180;255"), head = sgr("1;38;2;235;175;120");
const inv = sgr("7");
const DOT_OK = ok("●"), DOT_BAD = bad("●"), DOT_WARN = warn("●");
const plain = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - plain(s).length));

// ── data gathering (shared by CLI + TUI) ──────────────────────────────────────
type ProvView = { id: ProviderId; label: string; connected: boolean; detail: string; hint: string; count: number; age: number | null };
function providerViews(): ProvView[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
    const p = PROVIDERS[id];
    const pr = p.probe();
    return { id, label: p.label, connected: pr.connected, detail: pr.detail, hint: pr.loginHint, count: models(id).length, age: cacheAge(id) };
  });
}
const ageLabel = (ms: number | null, provider?: ProviderId) => (provider === "online" ? "built-in catalog" : ms === null ? "never refreshed" : ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);

/** Name anything the provider serves that we can't address, so nothing vanishes quietly. */
function dropNote(id: ProviderId, list: { id: string }[]): string {
  const dropped = unparseable(id, list);
  return dropped.length ? dim(` · not addressable: ${dropped.join(", ")}`) : "";
}

/**
 * The Codex catalog (`GET /backend-api/codex/models?client_version=…`) is GATED BY CLIENT
 * VERSION: every model carries a `minimal_client_version`, and the endpoint hides anything
 * newer than the client asking. GPT-6 Astra needs 0.153.0 (observed live 2026-09-05:
 * absent at 0.152.0, listed from 0.153.0 up). Reading Codex's own `models_cache.json`
 * therefore only ever showed what the INSTALLED Codex could see — a model that answers on
 * this subscription today was "unknown" here until the user upgraded a different tool.
 *
 * So the catalog is fetched here, as the newest Codex the machine knows of: the highest of
 * this floor (the newest Codex release when this was written), the installed Codex's own
 * cache stamp, its update-check stamp, and APIPLAN_CODEX_CLIENT_VERSION. The floor only
 * ever moves UP with the user's Codex, never down. The file stays as the offline fallback.
 * GPT-6 Sol and Luna need 0.155.0 (observed live 2026-09-29: absent at 0.153.4/0.154.9,
 * listed from 0.155.0 up to 99.0.0). P1 owns the single constant (CODEX_CLIENT_VERSION_FLOOR
 * in src/registry.ts); until it lands the literal below is the same number.
 */
const CODEX_CLIENT_VERSION: string = (R as any).CODEX_CLIENT_VERSION_FLOOR ?? "0.159.0";
const semverMax = (...vs: (string | undefined)[]) => vs.filter((v): v is string => !!v && /^\d+\.\d+\.\d+$/.test(v))
  .sort((a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); }).at(-1) ?? CODEX_CLIENT_VERSION;
/** a < b, both x.y.z (a malformed a counts as below). */
const semverLt = (a: string | undefined, b: string) => !a || !/^\d+\.\d+\.\d+$/.test(a) || (semverMax(a, b) === b && a !== b);
type CatalogEntry = { id: string; label: string; efforts?: string[]; contextWindow?: number };
/**
 * The catalog's `ultra` ("maximum reasoning with automatic task delegation") is a Codex
 * CLI mode, not a `reasoning.effort` the Responses endpoint accepts — sent as one it is a
 * 400 ("Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium',
 * 'high', 'xhigh', and 'max'", observed live 2026-09-05 on gpt-5.6-sol and gpt-6-astra).
 * Advertising it would make `-e ultra` fail on the models that list it, so it is dropped.
 */
const RESPONSES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// P1's registry version also keeps rank (same-version tie-break), input modalities and the
// default effort; prefer it, keep this one as the fallback for a registry without it.
const fromCodexCatalogLocal = (raw: any): CatalogEntry[] => (raw?.models ?? []).filter((m: any) => m.supported_in_api !== false).map((m: any) => ({
  id: m.slug ?? m.id, label: m.display_name ?? m.slug,
  efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e.effort).filter((e: any) => typeof e === "string" && RESPONSES_EFFORTS.has(e)),
  ...(typeof m.context_window === "number" ? { contextWindow: m.context_window } : {}),
})).filter((m: any) => m.id);
const fromCodexCatalog = (raw: any): CatalogEntry[] => (typeof (R as any).fromCodexCatalog === "function" ? (R as any).fromCodexCatalog(raw) : fromCodexCatalogLocal(raw));
async function refreshOpenaiCatalog(p = PROVIDERS.openai): Promise<{ list: CatalogEntry[]; source: string; clientVersion: string; live: boolean }> {
  const file = join(HOME, ".codex", "models_cache.json");
  const cached = readJson<any>(file, {});
  let version = semverMax(CODEX_CLIENT_VERSION, cached.client_version, readJson<any>(join(HOME, ".codex", "version.json"), {}).latest_version, process.env.APIPLAN_CODEX_CLIENT_VERSION);
  try {
    const c = p.creds();
    const base = process.env.APIPLAN_OPENAI_BASE || "https://chatgpt.com";
    const get = async (v: string) => {
      const r = await fetch(`${base}/backend-api/codex/models?client_version=${encodeURIComponent(v)}`, {
        headers: { authorization: `Bearer ${c.token}`, "chatgpt-account-id": c.account ?? "", originator: process.env.APIPLAN_ORIGINATOR || "codex_cli_rs" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    // Probe (P1, src/registry.ts): read once as a far-future client only to LEARN the version the
    // catalog needs, then ask as max(floor, that, stamps, env) — the next model shows up with no
    // code edit. Never stored: the server varies metadata by version. Best-effort; APIPLAN_CODEX_CATALOG_PROBE=0 disables.
    let hidden = "";
    let probeIds: string[] = [];
    const PROBE = (R as any).CODEX_CATALOG_PROBE_VERSION, needed = (R as any).neededClientVersion;
    if (PROBE && typeof needed === "function" && process.env.APIPLAN_CODEX_CATALOG_PROBE !== "0") {
      try { const raw = await get(PROBE); version = semverMax(version, needed(raw) ?? undefined); probeIds = fromCodexCatalog(raw).map((m) => m.id); } catch {}
    }
    const list = fromCodexCatalog(await get(version));
    if (!list.length) throw new Error("empty catalog");
    const missing = probeIds.filter((id) => !list.some((m) => m.id === id));
    if (missing.length) hidden = ` · hidden at ${version}: ${missing.join(", ")}`;
    return { list, source: `the live Codex catalog (as client ${version})${hidden}`, clientVersion: version, live: true };
  } catch (e: any) {
    // Offline, or the endpoint moved: Codex's own file is still the truth as of its stamp.
    const list = fromCodexCatalog(cached);
    if (!list.length) throw new Error(`catalog fetch failed (${e?.message ?? e}) and no models in ${file.replace(HOME, "~")}`);
    return { list, source: `codex cache (fetched ${cached.fetched_at ?? "?"}; live fetch failed: ${e?.message ?? e})`, clientVersion: String(cached.client_version ?? "unknown"), live: false };
  }
}

/** Ask each provider for its live model list. The one place that goes to the network. */
async function refreshModels(only?: ProviderId): Promise<string[]> {
  const notes: string[] = [];
  for (const id of (only ? [only] : (Object.keys(PROVIDERS) as ProviderId[]))) {
    const p = PROVIDERS[id];
    const connected = p.probe().connected;
    // A CATALOG READ THAT NEEDS NO CREDENTIAL MUST NOT BE SKIPPED FOR WANT OF ONE. `zen`'s
    // model list comes from a local file opencode wrote, not from an authenticated endpoint,
    // so an operator without a Zen key can still see what the gateway serves — and, more to
    // the point, still sees the counts of what this port does NOT serve. Behind the gate, that
    // note would be reachable only by someone who already has a key, i.e. never printed for
    // the person most likely to be puzzled by a partial list.
    if (!connected && id !== "zen") { notes.push(`${id}: not connected — kept previous list`); continue; }
    try {
      if (id === "anthropic") {
        const c = p.creds();
        const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: { authorization: `Bearer ${c.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "anthropic-client-platform": "cli", "x-app": "cli" },
        });
        const j: any = await r.json();
        if (!Array.isArray(j?.data)) throw new Error(j?.error?.message ?? `unexpected response (${r.status})`);
        const list = j.data.map((m: any) => ({ id: m.id, label: m.display_name ?? m.id }));
        saveModels(id, list);
        notes.push(`${id}: ${list.length} models from /v1/models${dropNote(id, list)}`);
      } else if (id === "google") {
        const r = await refreshGoogleCatalog();
        notes.push(`${id}: ${r.count} chat models from Antigravity's live catalog${r.imageModels.length ? ` · image generation: ${r.imageModels.join(", ")}` : " · no media generator advertised"}`);
      } else if (id === "ollama") {
        // The library is local, so this is the one refresh that needs no login and no
        // network: a loopback GET. It lives in the provider (refreshOllama) because the API
        // server calls the SAME code to register itself at startup — see ensureOllama().
        const r = await refreshOllama();
        notes.push(`${id}: ${r.count} local models from ${r.base}/api/tags · ${r.withTools} with tool support${dropNote(id, models(id).map((m) => ({ id: m.id })))}`);
      } else if (id === "zen") {
        // A LOCAL re-read, not a fetch: opencode writes its catalog to
        // ~/.cache/opencode/models.json and its own upstream is models.dev, which this gateway
        // has never spoken to — see refreshZenCatalog(). The counts are printed because the
        // port is a SUBSET: Zen publishes four wire dialects and this adapter serves one, so a
        // silent list would read as "these are all the zen models", which is false.
        const r = await refreshZenCatalog();
        saveModels(id, r.list);
        const d = r.dropped;
        const scanned = r.source === "file"
          ? `${r.count} Responses-dialect models from ${zenModelsFile().replace(HOME, "~")}`
          : `${r.count} Responses-dialect models from the built-in 2026-09-12 snapshot (no readable ${zenModelsFile().replace(HOME, "~")} — nothing scanned, so the counts below are not measured)`;
        const hidden = r.source === "file"
          ? ` · ${d.free.length} free-tier ids hidden — opencode-only (vendor: "OpenCode's free tier can only be used in OpenCode") · ${d.chat.length} chat-completions / ${d.anthropic.length} anthropic / ${d.google.length} google dialect ids not yet ported`
          : "";
        // The list is real either way; whether a CALL would work is a separate fact, and
        // saying so here stops "26 models" reading as "26 models you can use".
        const keyless = connected ? "" : " · no key yet, so this is the catalog only — `opencode auth login` or OPENCODE_API_KEY before a call";
        notes.push(`${id}: ${scanned}${hidden}${dropNote(id, r.list)}${keyless}`);
      } else {
        const r = await refreshOpenaiCatalog(p);
        saveModels(id, r.list);
        // Provenance sidecar: WHICH client version produced this list — `doctor` reads it to say
        // whether newer models may be hidden (a list fetched below the floor lacks GPT-6 Sol/Luna).
        writeJson(join(STATE_DIR, "models.openai.meta.json"), { fetched_at: Date.now(), client_version: r.clientVersion, live: r.live, source: r.source });
        notes.push(`${id}: ${r.list.length} models from ${r.source}${dropNote(id, r.list)}`);
      }
    } catch (e: any) { notes.push(`${id}: refresh failed — ${e?.message ?? e} (kept previous list)`); }
  }
  return notes;
}

/**
 * Speech has two distinct voice sets and the difference matters: read-aloud runs on
 * the subscription with ChatGPT's product voices; fresh text uses a separate live model.
 */
async function cmdVoices() {
  for (const p of Object.values(PROVIDERS)) {
    if (p.aloudVoices) {
      try {
        const { selected, voices } = await p.aloudVoices();
        process.stdout.write(`${bold("read-aloud")} ${dim(`— ${p.label} subscription, no API key  ·  --aloud`)}\n`);
        process.stdout.write(`  ${voices.map((v) => (v === selected ? bold(v) + dim("*") : v)).join("  ")}\n`);
        process.stdout.write(dim(`  * your ChatGPT default. Speaks a message already in your history.\n\n`));
      } catch (e: any) { process.stdout.write(`${bold("read-aloud")} ${dim("— unavailable: " + (e?.message ?? e))}\n\n`); }
    }
  }
  for (const p of Object.values(PROVIDERS)) {
    if (!p.speak || !p.voices?.length) continue;
    const custom = !!process.env.APIPLAN_TTS_BASE;
    process.stdout.write(`${bold("your own text")} ${dim(`— ${custom ? process.env.APIPLAN_TTS_BASE : "realtime, on your subscription — no API key"}  ·  --speak`)}\n`);
    process.stdout.write(`  ${p.voices.join("  ")}\n\n`);
  }
  process.stdout.write(`${bold("offline")} ${dim("— your operating system's own voice  ·  --local")}\n`);
}

// ── headless renderers ────────────────────────────────────────────────────────
async function cmdStatus() {
  const alive = await daemonAlive();
  process.stdout.write(`${bold("apiplan")} ${dim("v" + VERSION)}  ${dim("·")}  ${osLabel()}  ${dim("·")}  daemon ${alive ? ok("warm") : dim("cold")}\n\n`);
  process.stdout.write(head("PROVIDERS") + "\n");
  for (const p of providerViews()) {
    process.stdout.write(`  ${p.connected ? DOT_OK : DOT_BAD} ${pad(bold(p.id), 22)} ${p.detail}\n`);
    process.stdout.write(`    ${dim(p.label)} ${dim("·")} ${dim(`${p.count} models, ${ageLabel(p.age, p.id)}`)}\n`);
    if (!p.connected && p.hint) process.stdout.write(`    ${warn("→ " + p.hint)}\n`);
  }
  const cfg = C.load();
  const bd = C.binDirOf(cfg);
  process.stdout.write(`\n${head("COMMANDS")} ${dim(`${cfg.commands.length} configured in ${bd.replace(HOME, "~")}`)}\n`);
  if (!cfg.commands.length) process.stdout.write(`  ${dim("none yet —")} ${key("apiplan install")} ${dim("creates the default set")}\n`);
  else {
    const bad0 = cfg.commands.filter((c) => !C.health(cfg, c.name).onPath);
    process.stdout.write(`  ${cfg.commands.map((c) => (C.health(cfg, c.name).onPath ? c.name : dim(c.name))).join("  ")}\n`);
    if (bad0.length) process.stdout.write(`  ${warn(`${bad0.length} not resolving on PATH`)} ${dim("— run")} ${key("apiplan doctor")}\n`);
  }
}

function cmdModels(which?: string) {
  const p = which as ProviderId | undefined;
  const list = p ? models(p) : models();
  const byProv = new Map<string, Model[]>();
  for (const m of list) { const a = byProv.get(m.provider) ?? []; a.push(m); byProv.set(m.provider, a); }
  for (const [prov, ms] of byProv) {
    const pv = PROVIDERS[prov as ProviderId];
    const conn = pv.probe().connected;
    process.stdout.write(`\n${head(prov.toUpperCase())} ${conn ? ok("connected") : bad("not connected")} ${dim(`· ${ageLabel(cacheAge(prov as ProviderId), prov as ProviderId)}${cacheStale(prov as ProviderId) ? " (stale — apiplan models --refresh)" : ""}`)}\n`);
    const wId = Math.max(5, ...ms.map((m) => m.id.length)) + 2;
    const wAl = Math.max(7, ...ms.map((m) => aliasesFor(m).join(" ").length)) + 2;
    process.stdout.write(dim(`  ${pad("MODEL", wId)}${pad("ALIASES", wAl)}EFFORT\n`));
    for (const m of ms) {
      const al = aliasesFor(m);
      const newest = al.includes(m.family);
      process.stdout.write(`  ${pad(newest ? bold(m.id) : m.id, wId)}${pad(al.map((a) => key(a)).join(" "), wAl)}${dim(pv.efforts(m).join("/"))}\n`);
    }
  }
  process.stdout.write(`\n${dim("a family alias always means the newest of that family; explicit versions stay reachable (opus → newest, opus48 → 4.8)")}\n`);
}

function cmdCommands() {
  const cfg = C.load();
  if (!cfg.commands.length) { process.stdout.write(`${dim("no commands configured — run")} ${key("apiplan install")}\n`); return; }
  // widths from the actual content, so columns line up whatever the model ids are
  const wName = Math.max(7, ...cfg.commands.map((c) => c.name.length)) + 2;
  const target = (c: C.Command) => { const m = resolve(c.model); return m ? `${c.model} → ${m.id}` : `${c.model} (unknown)`; };
  const wModel = Math.max(5, ...cfg.commands.map((c) => target(c).length)) + 2;
  process.stdout.write(`\n${head("GLOBAL COMMANDS")} ${dim(C.binDirOf(cfg).replace(HOME, "~"))}\n`);
  process.stdout.write(dim(`    ${pad("COMMAND", wName)}${pad("MODEL", wModel)}FLAGS\n`));
  for (const c of cfg.commands) {
    const h = C.health(cfg, c.name);
    const m = resolve(c.model);
    const tgt = m ? `${c.model}${dim(" → " + m.id)}` : `${c.model}${bad(" (unknown)")}`;
    process.stdout.write(`  ${h.onPath ? DOT_OK : h.installed ? DOT_WARN : DOT_BAD} ${pad(bold(c.name), wName)}${pad(tgt, wModel)}${dim((c.flags ?? []).join(" ") || "—")}\n`);
  }
  process.stdout.write(`\n  ${DOT_OK} ${dim("on PATH")}   ${DOT_WARN} ${dim("installed but shadowed")}   ${DOT_BAD} ${dim("not installed")}\n`);
}

async function cmdDoctor() {
  const cfg = C.load();
  const bd = C.binDirOf(cfg);
  const json = has("--json");
  // state: true = ok · "warn" · false = bad · "info" = a fact worth showing, never a problem
  const rows: [string, boolean | "warn" | "info", string][] = [];
  rows.push(["runtime", true, `${process.execPath} (bun ${Bun.version})`]);
  rows.push(["platform", true, `${osLabel()} ${process.arch}`]);
  rows.push(["state dir", true, STATE_DIR.replace(HOME, "~")]);
  // Which tree these commands actually run — a curl-install and a dev checkout can
  // both exist, and knowing which one is wired is the difference between confusion
  // and a five-second fix.
  rows.push(["install root", true, join(import.meta.dir, "..").replace(HOME, "~")]);
  rows.push(["bin dir", true, bd.replace(HOME, "~")]);
  rows.push(["bin dir on PATH", onPath(bd) ? true : "warn", onPath(bd) ? "yes" : `no — add it: export PATH="${bd.replace(HOME, "$HOME")}:$PATH"`]);
  for (const p of providerViews()) rows.push([`provider ${p.id}`, p.connected, p.connected ? p.detail : `${p.detail} → ${p.hint}`]);
  // The Codex catalog hides models newer than the client that asks (see CODEX_CLIENT_VERSION):
  // a list fetched below the floor silently lacks GPT-6 Sol/Luna, and `luna` quietly means 5.6.
  const meta = readJson<{ client_version?: string; fetched_at?: number; live?: boolean }>(join(STATE_DIR, "models.openai.meta.json"), {});
  const refreshHint = "apiplan models --refresh --provider openai";
  if (!meta.client_version) rows.push(["catalog openai", "warn", `fetched by an older apiplan (client version unknown) — ${refreshHint}`]);
  else if (semverLt(meta.client_version, CODEX_CLIENT_VERSION)) rows.push(["catalog openai", "warn", `fetched as client ${meta.client_version}, below floor ${CODEX_CLIENT_VERSION} — newer models hidden · ${refreshHint}`]);
  else if (meta.live === false) rows.push(["catalog openai", "warn", `from codex's own cache (live fetch failed) as ${meta.client_version} — ${refreshHint}`]);
  else rows.push(["catalog openai", true, `client ${meta.client_version} · ${ageLabel(cacheAge("openai"))}`]);
  const six = models("openai").filter((m) => m.version[0] === 6).map((m) => m.id);
  const fb = typeof (R as any).fallbackIds === "function" ? ((R as any).fallbackIds("openai") as string[]).filter((id) => /^gpt-\d/.test(id)) : [];
  const missing = fb.filter((id) => !models("openai").some((m) => m.id === id));
  if (!six.length) rows.push(["gpt-6 lineup", "warn", `no GPT-6 model in the cached catalog — ${refreshHint}`]);
  else if (missing.length) rows.push(["gpt-6 lineup", "warn", `${six.join(", ")} · cache older than this apiplan: missing ${missing.join(", ")} — ${refreshHint}`]);
  else rows.push(["gpt-6 lineup", true, six.join(", ")]);
  const clip = IS_WIN ? "powershell" : process.platform === "darwin" ? (whichSync("pngpaste") ? "pngpaste" : "osascript fallback (pngpaste optional)") : whichSync("wl-paste") ? "wl-paste" : whichSync("xclip") ? "xclip" : "";
  rows.push(["image input", clip ? true : "warn", clip ? `-i file/URL/data:/- · clipboard via ${clip}` : "-i files work; clipboard needs wl-paste or xclip"]);
  rows.push(["aliases", "info", ["luna", "sol", "astra", "terra", "gpt", "luna6", "sol6", "luna56", "sol56"].map((a) => `${a}→${resolve(a)?.id ?? "?"}`).join(" ")]);
  const alive = await daemonAlive();
  rows.push(["daemon", alive ? true : "warn", alive ? "warm" : "cold (starts on first call)"]);
  // A warm daemon runs the code it was STARTED with; edits since then are invisible to it.
  if (!IS_WIN) {
    try {
      const ps = Bun.spawnSync(["ps", "-axo", "pid=,lstart=,command="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      const root = join(import.meta.dir, "..");
      // What a daemon runs: every src module plus its own entry file (ask.ts or apiplan.ts).
      const fs = require("node:fs");
      let srcNewest = 0;
      for (const f of fs.readdirSync(join(root, "src")) as string[]) if (f.endsWith(".ts")) srcNewest = Math.max(srcNewest, fs.statSync(join(root, "src", f)).mtimeMs);
      const entryMtime = (cmd: string) => { try { return fs.statSync(join(root, "bin", /apiplan\.ts/.test(cmd) ? "apiplan.ts" : "ask.ts")).mtimeMs; } catch { return 0; } };
      const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
      const procs = ps.split("\n").map((l) => l.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && /ask\.ts --daemon|apiplan\.ts daemon/.test(m[3]));
      if (!procs.length) rows.push(["daemon code", "info", "no daemon process"]);
      for (const m of procs) {
        const started = Date.parse(m[2]);
        const newest = Math.max(srcNewest, entryMtime(m[3]));
        if (started < newest) rows.push(["daemon code", "warn", `pid ${m[1]} started ${hhmm(started)}, code edited ${hhmm(newest)} — restart_needed (apiplan daemon stop; the next call respawns it)`]);
        else rows.push(["daemon code", true, `pid ${m[1]} started ${hhmm(started)}, newer than the code`]);
      }
    } catch {}
  }
  for (const c of cfg.commands) {
    const h = C.health(cfg, c.name);
    const m = resolve(c.model);
    if (!m) { rows.push([`cmd ${c.name}`, "warn", `model '${c.model}' no longer resolves — apiplan models --refresh, or apiplan rm ${c.name}`]); continue; }
    const where = h.onPath ? String(h.resolves).replace(HOME, "~") : !h.installed ? "not installed" : h.resolves ? `shadowed by ${h.resolves}` : "installed, but its bin dir is not on PATH";
    rows.push([`cmd ${c.name}`, h.onPath ? true : "warn", `${where} → ${m.id}`]);
  }
  const probs = rows.filter(([, s]) => s !== true && s !== "info").length;
  if (has("--strict")) process.exitCode = rows.some(([, s]) => s === false) ? 1 : 0;
  if (json) {
    process.stdout.write(JSON.stringify({ version: VERSION, rows: rows.map(([key, s, detail]) => ({ key, state: s === true ? "ok" : s === false ? "bad" : s, detail })), problems: probs }, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${head("DOCTOR")}\n`);
  for (const [k, state, detail] of rows) {
    process.stdout.write(`  ${state === true ? DOT_OK : state === "warn" ? DOT_WARN : state === "info" ? dim("·") : DOT_BAD} ${pad(k, 22)}${dim(detail)}\n`);
  }
  process.stdout.write(`\n  ${probs ? warn(`${probs} thing(s) to look at`) : ok("all clear")}\n`);
}

function reportSync(r: C.SyncReport) {
  if (r.written.length) {
    const names = [...new Set(r.written.map((f) => f.split(/[\\/]/).pop()!.replace(/\.(cmd|ps1)$/, "")))];
    process.stdout.write(`${ok("✓")} installed ${bold(String(names.length))} command(s) into ${r.binDir.replace(HOME, "~")}\n  ${names.join("  ")}\n`);
  }
  for (const s of r.skipped) {
    process.stdout.write(`${warn("!")} skipped ${bold(s.name)} — ${s.why}\n`);
    if (s.why.startsWith("would shadow")) {
      process.stdout.write(`    ${dim("pick another name:")} ${key(`apiplan rename ${s.name} ${s.name}2`)}   ${dim("or take the name anyway:")} ${key(`apiplan sync --force`)}\n`);
    }
  }
  if (!onPath(r.binDir)) process.stdout.write(`${warn("!")} ${r.binDir.replace(HOME, "~")} is not on PATH — add it and reopen your shell\n`);
}

/** The dry-run twin of reportSync: which shims would be new, changed (with a diff), unchanged. */
function reportPlan(p: C.SyncPlan) {
  process.stdout.write(`${bold("sync dry run")} ${dim(`— nothing written · ${p.binDir.replace(HOME, "~")}`)}\n`);
  process.stdout.write(`  new:       ${p.add.join(" ") || dim("(none)")}\n`);
  process.stdout.write(`  changed:   ${p.change.map((c) => c.name).join(" ") || dim("(none)")}\n`);
  process.stdout.write(`  unchanged: ${dim(String(p.same.length))}\n`);
  for (const c of p.change) {
    process.stdout.write(`  ${bold(c.name)}\n`);
    for (const l of c.before.split("\n").filter(Boolean)) process.stdout.write(`    - ${l}\n`);
    for (const l of c.after.split("\n").filter(Boolean)) process.stdout.write(`    + ${l}\n`);
  }
  for (const s of p.skipped) process.stdout.write(`${warn("!")} would skip ${bold(s.name)} — ${s.why}\n`);
}

// ── the TUI ───────────────────────────────────────────────────────────────────
type View = "home" | "models" | "commands";
async function tui() {
  if (!process.stdin.isTTY) { await cmdStatus(); return; }
  let view: View = "home";
  let sel = 0;
  let flash = "";
  let cfg = C.load();
  const out = process.stdout;

  const rows = () => (view === "commands" ? cfg.commands.length : view === "models" ? models().length : providerViews().length);

  function draw() {
    const alive = daemonWarm;
    let s = "\x1b[H\x1b[2J";
    s += `${bold("apiplan")} ${dim("v" + VERSION)}  ${dim("│")}  ${osLabel()}  ${dim("│")}  daemon ${alive ? ok("warm") : dim("cold")}  ${dim("│")}  ${ul(view)}\n`;
    s += dim("─".repeat(Math.min(out.columns || 80, 92))) + "\n";
    if (view === "home") {
      s += head("PROVIDERS") + "\n";
      providerViews().forEach((p, i) => {
        const mark = i === sel ? key("▸") : " ";
        s += ` ${mark} ${p.connected ? DOT_OK : DOT_BAD} ${pad(bold(p.id), 12)}${pad(dim(`${p.count} models`), 14)}${p.detail.slice(0, 46)}\n`;
        if (!p.connected && p.hint) s += `     ${warn("→ " + p.hint)}\n`;
      });
      const bd = C.binDirOf(cfg);
      s += `\n${head("COMMANDS")} ${dim(`${cfg.commands.length} in ${bd.replace(HOME, "~")}${onPath(bd) ? "" : "  (not on PATH!)"}`)}\n`;
      s += "  " + (cfg.commands.length ? cfg.commands.map((c) => (C.health(cfg, c.name).onPath ? c.name : dim(c.name))).join("  ") : dim("none — press i to install the default set")) + "\n";
    } else if (view === "models") {
      const list = models();
      s += dim(`  ${pad("MODEL", 30)}${pad("ALIASES", 24)}PROVIDER\n`);
      list.forEach((m, i) => {
        const mark = i === sel ? key("▸") : " ";
        const line = `${pad(aliasesFor(m).includes(m.family) ? bold(m.id) : m.id, 30)}${pad(aliasesFor(m).map(key).join(" "), 24)}${dim(m.provider)}`;
        s += ` ${mark} ${line}\n`;
      });
    } else {
      const wN = Math.max(7, ...cfg.commands.map((c) => c.name.length)) + 2;
      const wM = Math.max(5, ...cfg.commands.map((c) => c.model.length)) + 2;
      s += dim(`    ${pad("COMMAND", wN)}${pad("MODEL", wM)}FLAGS\n`);
      cfg.commands.forEach((c, i) => {
        const mark = i === sel ? key("▸") : " ";
        const h = C.health(cfg, c.name);
        s += ` ${mark} ${h.onPath ? DOT_OK : h.installed ? DOT_WARN : DOT_BAD} ${pad(bold(c.name), wN)}${pad(c.model, wM)}${dim((c.flags ?? []).join(" ") || "—")}\n`;
      });
      if (!cfg.commands.length) s += `  ${dim("none — press n to create one, or i for the default set")}\n`;
    }
    s += "\n" + dim("─".repeat(Math.min(out.columns || 80, 92))) + "\n";
    const keys = view === "commands"
      ? `${key("↑↓")} select  ${key("n")} new  ${key("r")} rename  ${key("f")} flags  ${key("d")} delete  ${key("s")} sync  ${key("1")} home  ${key("2")} models  ${key("q")} quit`
      : view === "models"
        ? `${key("↑↓")} select  ${key("c")} make command  ${key("R")} refresh list  ${key("1")} home  ${key("3")} commands  ${key("q")} quit`
        : `${key("↑↓")} select  ${key("i")} install defaults  ${key("R")} refresh models  ${key("D")} daemon  ${key("2")} models  ${key("3")} commands  ${key("q")} quit`;
    s += keys + "\n";
    if (flash) s += "\n" + flash + "\n";
    out.write(s);
  }

  let daemonWarm = await daemonAlive();
  const rl = async (prompt: string): Promise<string> => {
    process.stdin.setRawMode(false);
    out.write(`\n${prompt}`);
    const line = await new Promise<string>((res) => {
      let b = "";
      const on = (d: Buffer) => {
        b += d.toString();
        if (b.includes("\n")) { process.stdin.off("data", on); res(b.split("\n")[0]); }
      };
      process.stdin.on("data", on);
    });
    process.stdin.setRawMode(true);
    return line.trim();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.write("\x1b[?25l");
  const quit = (): never => { out.write("\x1b[?25h\x1b[2J\x1b[H"); process.stdin.setRawMode(false); process.exit(0); };
  draw();

  for await (const chunk of process.stdin) {
    const k = chunk.toString();
    flash = "";
    if (k === "q" || k === "\x03") quit();
    else if (k === "\x1b[A") sel = Math.max(0, sel - 1);
    else if (k === "\x1b[B") sel = Math.min(Math.max(0, rows() - 1), sel + 1);
    else if (k === "1") { view = "home"; sel = 0; }
    else if (k === "2") { view = "models"; sel = 0; }
    else if (k === "3") { view = "commands"; sel = 0; }
    else if (k === "i") { const r = C.sync({ ...cfg, commands: cfg.commands.length ? cfg.commands : (cfg.commands = C.defaults(), cfg.commands) }); C.save(cfg); flash = `${ok("✓")} installed ${r.written.length} file(s)${r.skipped.length ? `, skipped ${r.skipped.map((x) => x.name).join(", ")}` : ""}`; }
    else if (k === "s") { const r = C.sync(cfg); flash = `${ok("✓")} synced ${r.written.length} file(s)${r.skipped.length ? `, skipped ${r.skipped.map((x) => `${x.name} (${x.why})`).join("; ")}` : ""}`; }
    else if (k === "R") { flash = dim("refreshing…"); draw(); const n = await refreshModels(); flash = n.map((x) => dim(x)).join("\n"); }
    else if (k === "D") { daemonWarm = await daemonAlive(); flash = daemonWarm ? ((await daemonStop()), (daemonWarm = false), `${ok("✓")} daemon stopped`) : dim("daemon is cold; it starts itself on the next call"); }
    else if (view === "models" && k === "c") {
      const m = models()[sel];
      const name = await rl(`command name for ${m.label} (blank = cancel): `);
      if (name) {
        const flags = await rl(`extra flags (e.g. -e low --stream), blank for none: `);
        const r = C.add(cfg, { name, model: aliasesFor(m)[0] ?? m.id, ...(flags ? { flags: flags.split(/\s+/) } : {}) });
        if (r.ok) { C.save(cfg); const s2 = C.sync(cfg, { only: [name] }); flash = s2.skipped.length ? `${warn("!")} ${s2.skipped[0].why}` : `${ok("✓")} created ${bold(name)} → ${m.id}`; }
        else flash = `${bad("✗")} ${r.why}`;
      }
    } else if (view === "commands" && cfg.commands.length) {
      const cur = cfg.commands[sel];
      if (k === "r") {
        const to = await rl(`rename ${bold(cur.name)} to: `);
        if (to) { const r = C.rename(cfg, cur.name, to); if (r.ok) { C.save(cfg); C.sync(cfg, { only: [to] }); flash = `${ok("✓")} renamed to ${bold(to)}`; } else flash = `${bad("✗")} ${r.why}`; }
      } else if (k === "f") {
        const flags = await rl(`flags for ${bold(cur.name)} (current: ${(cur.flags ?? []).join(" ") || "none"}): `);
        cur.flags = flags ? flags.split(/\s+/) : undefined;
        C.save(cfg); C.sync(cfg, { only: [cur.name] });
        flash = `${ok("✓")} ${cur.name} flags = ${(cur.flags ?? []).join(" ") || "none"}`;
      } else if (k === "d") {
        const yes = await rl(`delete ${bold(cur.name)}? type y to confirm: `);
        if (yes.toLowerCase() === "y") { const r = C.remove(cfg, cur.name); C.save(cfg); sel = Math.max(0, sel - 1); flash = r.ok ? `${ok("✓")} removed (${(r.removed ?? []).length} file)` : `${bad("✗")} ${r.why}`; }
      } else if (k === "n") {
        const name = await rl("new command name: ");
        if (name) {
          const model = await rl("model (opus, opus48, sol, gpt55, …): ");
          const flags = await rl("extra flags (blank for none): ");
          const r = C.add(cfg, { name, model, ...(flags ? { flags: flags.split(/\s+/) } : {}) });
          if (r.ok) { C.save(cfg); const s2 = C.sync(cfg, { only: [name] }); flash = s2.skipped.length ? `${warn("!")} ${s2.skipped[0].why}` : `${ok("✓")} created ${bold(name)}`; }
          else flash = `${bad("✗")} ${r.why}`;
        }
      }
    }
    cfg = C.load();
    draw();
  }
}

// ── dispatch ──────────────────────────────────────────────────────────────────
function usage(): string {
  return `${bold("apiplan")} ${dim("v" + VERSION)} — one place to manage every model command on this machine

USAGE
  apiplan                        interactive dashboard (providers · models · commands)
  apiplan status                 which providers am I connected to?
  apiplan models [provider]      every model + the aliases that reach it   ${dim("--refresh")}
  apiplan roster omp [--apply <models.yml>]   the one-provider model list for omp/OM, in apiplan's order
  apiplan media                  image/video/music/speech models on your Gemini key
  apiplan vision <video>         ordered concurrent Gemini frame understanding
  apiplan commands               every global command, and whether PATH finds it
  apiplan voices                 every speech voice available to you, and from where
  apiplan usage [--json] [--provider anthropic|openai]  subscription 5h + weekly windows, per provider
  apiplan live-models [--json]    voice models, transports and supported capabilities
  apiplan live-check [--live-model m] [--text words]  bounded subscription audio check
  apiplan install [--dry-run]    create the default command set and put it on PATH (--dry-run: show what would change)
  apiplan add <name> --model <m> [--flags "…"]      make a new command
  apiplan rename <old> <new>     rename one
  apiplan rm <name>              remove one
  apiplan sync [names…] [--force] [--dry-run]  rebuild shims from the config (all, or just these)
  apiplan prune                  remove commands left over from an earlier install
  apiplan doctor [--json] [--strict]  diagnose PATH, logins, catalog, daemon, shadowed names
  apiplan update                 pull the latest apiplan, re-sync commands + models
  apiplan daemon [stop]          run or stop the warm daemon
  apiplan serve [--port N] [--host H] [--key-file F] [--keys-file F] [--cors ORIGIN]
                                 an OpenAI- and Anthropic-shaped API (loopback by default;
                                 any other --host requires a key: --key-file / APIPLAN_SERVE_KEY)
  apiplan keys new <label>       mint a per-device/project key for serve (shown ONCE; only its hash is kept)
  apiplan keys list              every key: id, label, created, revoked, requests, tokens, cost to date
  apiplan keys revoke <id>       refuse that key from now on (a running server picks it up live)
  apiplan keys usage [--since 24h|7d] [--json]   per-key totals from the usage ledger
  apiplan hotswap <status|upgrade> [--wait-seconds N]
                                 drain + replace the live 8787 server without breaking clients
  apiplan talk [--voice v] [--live-model m]  speak with the model out loud, both ways
                                 codex-live also accepts --duration seconds / --input-audio file
                                 ${dim("uses the warm daemon when one is up (~half the latency);")}
                                 ${dim("--direct forces the in-process path · --park pre-warms it")}
  apiplan path                   print the line that puts commands on your PATH
  apiplan shell-init [shell]     shell glue so ? and * in a prompt need no quotes
                                 ${dim(`add to your rc:  eval "$(apiplan shell-init)"`)}
  apiplan completions [zsh|bash|fish]  tab-completion script (shell-init includes it)

Config: ${C.configPath().replace(HOME, "~")}   ${dim("(plain JSON — safe to edit by hand, then `apiplan sync`)")}

A family name always calls the newest model in that family (${key("opus")} → newest Opus);
an explicit version is always still reachable (${key("opus48")}, ${key("sonnet46")}, ${key("gpt55")}).`;
}

const argv = process.argv.slice(2);
// Website sessions are a separate product surface, never provider/Codex credentials.
if (argv[0] === "chatgpt") {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "chatgpt.ts"), ...argv.slice(1)], {stdin:"inherit",stdout:"inherit",stderr:"inherit"});
  process.exit(await child.exited);
}
const sub = argv[0];
const has = (f: string) => argv.includes(f);
const valOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
/**
 * For flags that may be used bare OR with a value (--greet, --greet "open warmly").
 * The next token counts as the value only when it isn't another flag — otherwise
 * `--greet --voice cedar` reads "--voice" as the greeting text, which is exactly how a
 * persona got silently overridden. Values that legitimately begin with "-" (a flag
 * string like "-e low --stream") still work through plain valOf.
 */
const optVal = (f: string) => {
  const i = argv.indexOf(f);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("-") ? true : v;
};

/**
 * Start a daemon that will hold a warm realtime socket, and DON'T wait for it. Parking
 * is opt-in at daemon boot (`APIPLAN_TALK_PARK`) because most daemon lifetimes only ever
 * serve text calls and have no business holding an open voice session — but a daemon
 * spawned by `talk` exists precisely to hold one, so it is armed from birth. This call
 * goes direct regardless; the NEXT one finds the socket already connected and configured.
 */
function spawnTalkDaemon(model?: string, voice?: string) {
  try {
    const p = Bun.spawn([process.execPath, import.meta.path, "daemon"], {
      env: { ...process.env, APIPLAN_TALK_PARK: "on", ...(model ? { APIPLAN_LIVE_MODEL: model } : {}), ...(voice ? { APIPLAN_VOICE: voice } : {}) },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    p.unref();
  } catch {}
}

switch (sub) {
  case undefined: await tui(); break;
  case "status": case "providers": await cmdStatus(); break;
  case "roster": {
    // `apiplan roster omp` prints the `apiplan:` provider block; `--apply <file>` rewrites
    // that file in place (backup beside it), replacing every apiplan* provider it had.
    const yaml = rosterYaml();
    const i = argv.indexOf("--apply");
    if (i < 0) { process.stdout.write(yaml); break; }
    const file = argv[i + 1];
    if (!file) die("--apply needs the models.yml to rewrite");
    const fs = require("node:fs");
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const bak = `${file}.bak-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    if (before) fs.writeFileSync(bak, before);
    fs.writeFileSync(file, applyRoster(before, yaml));
    const n = (yaml.match(/^      - id:/gm) ?? []).length;
    process.stdout.write(`${ok("✓")} ${file.replace(HOME, "~")}: one \`apiplan\` provider, ${n} models in apiplan's order${before ? dim(`  (backup ${bak.replace(HOME, "~")})`) : ""}\n`);
    break;
  }
  case "models": {
    if (has("--refresh") || has("-r")) for (const n of await refreshModels(valOf("--provider") as ProviderId | undefined)) process.stdout.write(dim(`  ${n}\n`));
    cmdModels(argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined);
    break;
  }
  case "media": {
    try {
      const { discoverGeminiMedia } = await import("../src/gemini-media.ts");
      const rows = await discoverGeminiMedia();
      process.stdout.write(`\n${head("GEMINI GENERATIVE MEDIA")} ${dim("public API key · ~/.config/gemini/api_key")}\n`);
      for (const kind of ["image", "video", "music", "speech"]) {
        const ms = rows.filter((r) => r.kind === kind);
        process.stdout.write(`\n  ${bold(kind.toUpperCase())}\n`);
        for (const m of ms) process.stdout.write(`    ${key(m.model)}${m.description ? dim(` · ${m.description}`) : ""}\n`);
      }
      process.stdout.write(`\n${dim("global CLI: gemini --draw … · gemini --video … · gemini --song …")}\n`);
      process.stdout.write(dim("AGY subscription generation: image only; Veo/Lyria/TTS use the separate Gemini API key.\n"));
    } catch (e: any) { die(e?.message ?? String(e)); }
    break;
  }
  case "vision": {
    const { runVisionCLI } = await import("./vision.ts");
    await runVisionCLI(argv.slice(1));
    break;
  }
  case "commands": case "ls": cmdCommands(); break;
  case "voices": await cmdVoices(); break;
  case "live-models": {
    const selected = resolveLiveModel();
    if (has("--json")) process.stdout.write(JSON.stringify({ default: DEFAULT_LIVE_MODEL, selected: selected.id, models: LIVE_MODELS }, null, 2) + "\n");
    else {
      process.stdout.write(`Voice model default: ${DEFAULT_LIVE_MODEL}; selected: ${selected.id}\n\n`);
      for (const m of LIVE_MODELS) {
        process.stdout.write(`${m.id}${m.id === selected.id ? " *" : ""}  [${m.transport}]\n`);
        process.stdout.write(`  ${Object.entries(m.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ")}\n  ${m.evidence}\n`);
      }
      process.stdout.write("\nSelect with --live-model (alias --realtime-model), APIPLAN_LIVE_MODEL, or legacy APIPLAN_REALTIME_MODEL.\nCustom compatible Realtime WebSocket model IDs are accepted. Listing does not verify account access.\n");
    }
    break;
  }
  case "live-check": {
    let code = 0;
    try {
      const model = resolveLiveModel(liveModelArgument(argv));
      const text = valOf("--text") ?? "APIPlan voice is connected.";
      if (model.transport === "gemini-bidi") {
        // A Gemini live model cannot be "spoken to" the way live-check speaks to a
        // Realtime model: these ids refuse a TEXT modality outright, so there is no
        // "read this sentence" path. What CAN be verified end to end is the thing they do
        // — audio in, audio or transcript out — so the check feeds a short synthesized
        // clip and reports what came back. `--text` still chooses the words, via `say`.
        requireLiveCapability(model, model.capabilities.dictation ? "dictation" : "talk");
        // Dynamic, like every sibling branch here: this one-shot CLI loads exactly the one
        // transport the caller asked for, so a Realtime call never pays to parse the Bidi
        // client (or vice versa). The specifier is a literal; the LAZINESS is the point.
        const { checkGeminiLive } = await import("../src/gemini-live.ts");
        const report = await checkGeminiLive(model, text, { out: valOf("--out") ?? undefined });
        process.stdout.write(JSON.stringify({ ok: true, model: model.id, transport: model.transport, ...report }, null, 2) + "\n");
      } else if (model.transport === "codex-webrtc") {
        const { speakCodexLive } = await import("../src/codex-live.ts");
        const report = await speakCodexLive(text, { voice: valOf("--voice") ?? undefined, timeoutMs: 45000 });
        process.stdout.write(JSON.stringify({ ok: true, model: model.id, transport: model.transport, ...report }, null, 2) + "\n");
      } else {
        const { speakRealtime, openai } = await import("../src/providers.ts");
        const started = Date.now();
        const result = await speakRealtime(openai.creds(), { text, voice: valOf("--voice") ?? "cedar", format: "wav", liveModel: model.id }, 30000);
        const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
        let peak = 0;
        for (let i = 44; i + 1 < view.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
        if (!peak) throw new Error("The subscription returned only silent audio.");
        process.stdout.write(JSON.stringify({ ok: true, model: model.id, transport: model.transport, audioBytes: result.bytes.length, peakPcm16: peak, elapsedMs: Date.now() - started }, null, 2) + "\n");
      }
    } catch (error: any) { process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + "\n"); code = 1; }
    // The optional native addon's worker threads outlive the peer; this one-shot CLI owns the process.
    process.exit(code);
  }
  case "install": {
    const cfg = C.load();
    // Seed a fresh machine, and top up an existing one with defaults added since it
    // was installed — otherwise an upgrade's new commands never reach anybody.
    const fresh = !cfg.commands.length;
    if (fresh) cfg.commands = C.defaults();
    const gained = fresh ? [] : C.mergeDefaults(cfg);
    const notes = fresh ? [] : C.refreshNotes(cfg);
    if (has("--dry-run")) {
      // Preview only: the config diff this install would make, then the shim diff.
      const names = fresh ? cfg.commands.map((c) => c.name) : gained;
      process.stdout.write(`${bold("dry run")} ${dim("— nothing written")}\n  would add: ${names.join(" ") || "(nothing)"}\n`);
      for (const n of cfg.commands.filter((c) => names.includes(c.name))) process.stdout.write(dim(`    + ${n.name} → ${n.model}${n.flags?.length ? " " + n.flags.join(" ") : ""}${n.note ? `  (${n.note})` : ""}\n`));
      for (const n of notes) process.stdout.write(`  would re-label ${n}\n`);
      reportPlan(C.planSync(cfg, { force: has("--force") }));
      break;
    }
    C.save(cfg);
    if (gained.length) process.stdout.write(dim(`  new in this version: ${gained.join(" ")}\n`));
    for (const n of notes) process.stdout.write(dim(`  re-labelled ${n}\n`));
    reportSync(C.sync(cfg, { force: has("--force") }));
    break;
  }
  case "sync": {
    const cfg = C.load();
    // `apiplan sync luna6 sol6` rebuilds just those shims; bare `sync` rebuilds all.
    const names = argv.slice(1).filter((a) => !a.startsWith("-"));
    const unknown = names.filter((n) => !cfg.commands.some((c) => c.name === n));
    for (const n of unknown) process.stdout.write(`${warn("!")} no command named ${bold(n)} — see ${key("apiplan commands")}\n`);
    const known = names.filter((n) => !unknown.includes(n));
    if (names.length && !known.length) { process.exitCode = 1; break; }
    const opts = { force: has("--force"), ...(names.length ? { only: known } : {}) };
    if (has("--dry-run")) reportPlan(C.planSync(cfg, opts));
    else reportSync(C.sync(cfg, opts));
    if (!names.length) {
      const orph = C.orphans(cfg);
      if (orph.length) process.stdout.write(`${warn("!")} ${orph.length} leftover command(s) from an earlier install: ${orph.join(" ")}\n    ${dim("remove them:")} ${key("apiplan prune")}\n`);
    }
    if (unknown.length) process.exitCode = 1;
    break;
  }
  case "prune": {
    const cfg = C.load();
    const orph = C.orphans(cfg);
    if (!orph.length) { process.stdout.write(`${ok("✓")} nothing to prune\n`); break; }
    const gone = C.prune(cfg);
    process.stdout.write(`${ok("✓")} removed ${orph.length} leftover command(s): ${orph.join(" ")} ${dim(`(${gone.length} file(s))`)}\n`);
    break;
  }
  case "add": {
    const name = argv[1];
    const model = valOf("--model") ?? valOf("-m");
    if (!name || !model) die(`usage: apiplan add <name> --model <model> [--flags "-e low --stream"]`);
    const flagsRaw = valOf("--flags");
    const cfg = C.load();
    const r = C.add(cfg, { name, model, ...(flagsRaw ? { flags: flagsRaw.trim().split(/\s+/) } : {}) });
    if (!r.ok) die(r.why!);
    C.save(cfg);
    reportSync(C.sync(cfg, { only: [name], force: has("--force") }));
    break;
  }
  case "rename": {
    const [, from, to] = argv;
    if (!from || !to) die("usage: apiplan rename <old> <new>");
    const cfg = C.load();
    const r = C.rename(cfg, from, to);
    if (!r.ok) die(r.why!);
    C.save(cfg);
    reportSync(C.sync(cfg, { only: [to], force: has("--force") }));
    break;
  }
  case "rm": case "remove": {
    const name = argv[1];
    if (!name) die("usage: apiplan rm <name>");
    const cfg = C.load();
    const r = C.remove(cfg, name);
    if (!r.ok) die(r.why!);
    C.save(cfg);
    process.stdout.write(`${ok("✓")} removed ${bold(name)}\n`);
    break;
  }
  case "update": {
    // Where this very file lives IS the install — pull it and re-sync, so a new
    // machine only ever needs one command to get current.
    const root = join(import.meta.dir, "..");
    const git = Bun.spawnSync(["git", "-C", root, "pull", "--ff-only"], { stdout: "pipe", stderr: "pipe" });
    const out = (git.stdout.toString() + git.stderr.toString()).trim();
    if (git.exitCode !== 0) {
      process.stdout.write(`${warn("!")} could not update ${root.replace(HOME, "~")}\n    ${dim(out.split("\n")[0] ?? "")}\n`);
      process.stdout.write(`    ${dim("if you have local changes, commit or stash them first")}\n`);
    } else {
      process.stdout.write(`${ok("✓")} ${out.includes("up to date") ? "already current" : "updated"} ${dim(root.replace(HOME, "~"))}\n`);
    }
    const cfg = C.load();
    reportSync(C.sync(cfg));
    const orph = C.orphans(cfg);
    if (orph.length) process.stdout.write(`${dim("leftover from an older version:")} ${orph.join(" ")} ${dim("→")} ${key("apiplan prune")}\n`);
    for (const n of await refreshModels()) process.stdout.write(dim(`  ${n}\n`));
    break;
  }
  case "doctor": await cmdDoctor(); break;
  case "usage": {
    const { subscriptionUsage, USAGE_PROVIDERS } = await import("../src/usage.ts");
    const p = valOf("--provider");
    if (p && !USAGE_PROVIDERS.includes(p as any)) die(`usage: apiplan usage [--json] [--provider ${USAGE_PROVIDERS.join("|")}]`);
    const r = await subscriptionUsage(p as any);
    if (has("--json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); break; }
    const bar = (n: number) => { const f = Math.max(0, Math.min(20, Math.round(n / 5))); const s = "\u2588".repeat(f) + dim("\u2591".repeat(20 - f)); return n >= 90 ? bad(s) : n >= 70 ? warn(s) : ok(s); };
    const when = (t: string | null) => { if (!t) return ""; const ms = Date.parse(t) - Date.now(); if (ms <= 0) return dim(" resets now"); const h = Math.floor(ms / 3_600_000), m = Math.round((ms % 3_600_000) / 60_000); return dim(` resets in ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`} (${t})`); };
    const row = (label: string, w: { used_percent: number; resets_at: string | null } | null) =>
      process.stdout.write(`  ${pad(label, 22)} ${w ? `${bar(w.used_percent)} ${pad(`${w.used_percent}%`, 7)}${when(w.resets_at)}` : dim("\u2014 not reported")}\n`);
    for (const [id, u] of Object.entries(r)) {
      if (!u) continue;
      process.stdout.write(`${head(id)}${u.account ? `  ${u.account}` : ""}${u.plan ? dim(` \u00b7 ${u.plan}`) : ""}${u.status ? dim(` \u00b7 ${u.status}`) : ""}\n`);
      if (u.error) process.stdout.write(`  ${DOT_BAD} ${u.error}\n`);
      if (u.five_hour || !u.error) row("5-hour", u.five_hour);
      if (u.seven_day || !u.error) row("weekly", u.seven_day);
      for (const [k, w] of Object.entries(u.extra)) row(k, w);
      process.stdout.write(dim(`  source: ${u.source} \u00b7 fetched ${u.fetched_at}\n\n`));
    }
    break;
  }
  case "talk": case "converse": {
    // A persona long enough to be worth writing belongs in a file, not in argv.
    const personaFrom = () => {
      const f = valOf("--as-file") ?? valOf("--persona");
      const inline = valOf("--as") ?? valOf("--direction");
      const fromFile = f ? require("node:fs").readFileSync(f, "utf8").trim() : "";
      return [fromFile, inline].filter(Boolean).join("\n\n") || undefined;
    };
    const label = { you: key("you  "), model: ok("model"), info: dim("·    ") };
    const render = (kind: "you" | "model" | "info", text: string) =>
      process.stdout.write(`  ${label[kind]} ${kind === "info" ? dim(text) : text}\n`);
    // --tools <module>: a JS/TS module exporting { tools, onTool } (e.g. live-explain's
    // lx_tools.mjs). Only names present in `tools` are ever dispatched — talk() enforces
    // the allow-list; onTool is the module's own code, never shell/eval here.
    let toolset: { tools?: any[]; onTool?: any } = {};
    const toolsPath = valOf("--tools");
    if (toolsPath) {
      try {
        const m: any = await import(require("node:path").resolve(toolsPath));
        toolset = { tools: m.tools ?? m.default?.tools, onTool: m.onTool ?? m.default?.onTool };
        if (!toolset.tools?.length || typeof toolset.onTool !== "function") throw new Error("module must export `tools` (array) and `onTool` (function)");
      } catch (e: any) { process.stderr.write(dim(`  · tools module failed to load (${e?.message ?? e}) — continuing without tools\n`)); toolset = {}; }
    }
    const req = {
      voice: valOf("--voice") ?? undefined,
      model: resolveLiveModel(liveModelArgument(argv)).id,
      duration: valOf("--duration") ? Number(valOf("--duration")) : undefined,
      inputFile: valOf("--input-audio") ?? undefined,
      direction: personaFrom(),
      greet: optVal("--greet"),
      barge: has("--barge"),
      hangup: has("--no-bye") ? [] : (valOf("--bye")?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["bye", "goodbye", "good bye"]),
      logFile: valOf("--log") ?? undefined,
      tools: toolset.tools,
      onTool: toolset.onTool,
    };
    const selected = resolveLiveModel(req.model);
    if (toolsPath && !selected.capabilities.functionTools) die(`${selected.id} does not support Realtime --tools modules.`);
    if (req.duration !== undefined && (!Number.isFinite(req.duration) || req.duration <= 0)) die("--duration must be a positive number of seconds.");
    if (req.inputFile && !req.duration) die("--input-audio requires --duration to bound the call.");
    if (selected.transport !== "codex-webrtc" && (req.duration || req.inputFile)) die("--duration and --input-audio currently apply only to codex-live talk.");

    // `--park` arms the warm socket and leaves: it is the "make the NEXT call fast" verb,
    // useful before a demo and as the bench harness's setup step.
    if (has("--park")) {
      requireLiveCapability(selected, "park");
      const { daemonParkStatus } = await import("../src/talk-daemon.ts");
      // A daemon that answers /health but not /talk/status is a stale-code daemon from
      // before park support — stop it so a fresh, park-capable one takes its place.
      if ((await daemonAlive()) && !(await daemonParkStatus())) { await daemonStop(); await Bun.sleep(300); }
      if (!(await daemonAlive())) { spawnTalkDaemon(req.model, req.voice); await Bun.sleep(600); }
      // The status probe alone does not park; ask the daemon to park by restarting it
      // with parking on, which is what spawnTalkDaemon() already sets.
      let st = await daemonParkStatus();
      if (st && st.model !== req.model) die(`daemon is configured for ${st.model}, not ${req.model}. A normal talk call selects ${req.model} without reusing that socket; --park requires a matching daemon.`);
      for (let i = 0; i < 20 && st && st.state !== "ready"; i++) { await Bun.sleep(400); st = await daemonParkStatus(); }
      process.stdout.write(st ? JSON.stringify(st, null, 2) + "\n" : "daemon not reachable\n");
      break;
    }

    // The daemon holds a pre-connected, pre-configured realtime socket and owns ffmpeg /
    // ffplay, so the fast path is: hand it the request and render the transcript it
    // streams back. `--direct` forces the in-process path — the original behaviour, and
    // the control arm when measuring what the daemon is actually worth.
    if (selected.capabilities.park && !has("--direct") && (process.env.APIPLAN_DAEMON ?? "auto") !== "off") {
      const { talkViaDaemon } = await import("../src/talk-daemon.ts");
      try { if (await talkViaDaemon(req, render)) break; } catch { /* fall through to direct */ }
      // Nothing was listening. Start one for next time — the same rule the text path
      // follows: a cold start must never be SLOWER than having no daemon at all.
      spawnTalkDaemon(req.model, req.voice);
    }

    const { talk } = await import("../src/talk.ts");
    try {
      const result = await talk({ ...req, onEvent: render });
      if (result.reason === "error" || result.reason === "mic-lost" || (result.reason === "timeout" && result.detail)) die(result.detail ?? result.reason);
      if (selected.transport === "codex-webrtc") process.exit(0);
    } catch (e: any) { die(e?.message ?? String(e)); }
    break;
  }
  case "hotswap": {
    const action = argv[1] ?? "status";
    const waitSeconds = Number(valOf("--wait-seconds") ?? "300");
    const port = Number(valOf("--port") ?? process.env.APIPLAN_HOTSWAP_PORT ?? "8787");
    const base = `http://127.0.0.1:${port}`;
    const stateFile = `${process.env.HOME}/.apiplan/hotswap-${port}.json`;
    // A keyed server still opens its control plane to a local, unproxied caller; the key is
    // sent anyway so hotswap also works where that exemption does not apply.
    const { inboundKey } = await import("../src/api.ts");
    const hsKey = (() => { try { return inboundKey({ keyFile: valOf("--key-file") ?? undefined }); } catch { return undefined; } })();
    const hsHeaders: Record<string, string> = hsKey ? { authorization: `Bearer ${hsKey}` } : {};
    const control = async () => {
      try {
        const response = await fetch(`${base}/_apiplan/control`, { headers: hsHeaders });
        if (!response.ok) return null;
        const value = await response.json() as any;
        return typeof value?.pid === "number" && typeof value?.cachePolicy === "string" ? value : null;
      } catch { return null; }
    };
    if (action === "status") {
      const live = await control();
      process.stdout.write(JSON.stringify({ live, state: readJson(stateFile, null) }, null, 2) + "\n");
      break;
    }
    if (action === "upgrade") {
      const live = await control();
      if (!live) die("no live APIPlan control endpoint on this port");
      const priorPid = live.pid;
      const drained = await (await fetch(`${base}/_apiplan/drain`, { method: "POST", headers: hsHeaders })).json() as Record<string, unknown>;
      const deadline = Date.now() + waitSeconds * 1000;
      let last = drained;
      while (Number(last.activeRequests ?? 0) > 0 && Date.now() < deadline) {
        await Bun.sleep(250);
        last = await control() ?? last;
      }
      if (Number(last.activeRequests ?? 0) > 0) die(`drain timed out with ${last.activeRequests} active request(s); the old server remains alive`);
      try { process.kill(priorPid, "SIGTERM"); } catch {}
      for (let i = 0; i < 40; i++) { try { process.kill(priorPid, 0); await Bun.sleep(100); } catch { break; } }
      const child = Bun.spawn([process.execPath, import.meta.path, "serve", "--port", String(port),
        // The replacement binds where the old one did, with the same key source.
        ...(typeof live.hostname === "string" ? ["--host", live.hostname] : []),
        ...(valOf("--key-file") ? ["--key-file", valOf("--key-file")!] : [])], {
        env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      child.unref();
      let upgraded: Record<string, unknown> | null = null;
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(100);
        upgraded = await control();
        if (upgraded?.cachePolicy === "cached" && upgraded.accepting) break;
      }
      if (!upgraded || upgraded.cachePolicy !== "cached" || !upgraded.accepting) die(`upgraded server failed to claim ${port}`);
      writeJson(stateFile, { version: 2, phase: "upgraded", priorPid, upgradedPid: upgraded.pid, upgradedAt: Date.now() });
      process.stdout.write(`upgraded: cached server pid ${upgraded.pid} owns ${port}; existing clients reconnect automatically\n`);
      break;
    }
    die(`unknown hotswap action '${action}' (use status or upgrade)`);
    break;
  }
  case "keys": {
    const K = await import("../src/serve-keys.ts");
    const file = valOf("--keys-file") ?? K.keysFile();
    const action = argv[1];
    const num = (n: number) => n.toLocaleString("en-US");
    const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(6) : n.toFixed(4)}`;
    const day = (t?: string | null) => (t ? t.slice(0, 16).replace("T", " ") : "—");
    if (action === "new") {
      const label = argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--keys-file").join(" ");
      if (!label) die("usage: apiplan keys new <label>   (the device or project this key is for)");
      const { record, key: k } = K.createKey(label, file);
      process.stdout.write(`${ok("✓")} key ${bold(record.id)} for ${bold(record.label)}\n\n  ${k}\n\n`);
      process.stdout.write(dim(`  Shown once — only its sha256 is stored (${file.replace(HOME, "~")}, mode 0600).\n`));
      process.stdout.write(dim(`  Send as  Authorization: Bearer <key>  or  x-api-key: <key>.\n`));
      process.stdout.write(warn(`  A serve using this store now requires a valid key from EVERY caller, loopback included\n  (keyless only with APIPLAN_SERVE_OPEN=1). A placeholder key (OM's apiKey: not-needed) gets 401.\n`));
      break;
    }
    if (action === "revoke") {
      const id = argv[2];
      if (!id) die("usage: apiplan keys revoke <id>");
      try { const r = K.revokeKey(id, file); process.stdout.write(`${ok("✓")} key ${bold(r.id)} (${r.label}) revoked at ${r.revoked_at}\n`); }
      catch (e: any) { die(e?.message ?? String(e)); }
      break;
    }
    if (action === "list" || action === "ls" || action === undefined) {
      const store = K.readStore(file);
      const tot = new Map(K.totalsByKey(K.readLedger()).map((t) => [t.key_id, t]));
      const others = [...tot.values()].filter((t) => !store.keys.some((k) => k.id === t.key_id));
      const rows = store.keys.map((k) => ({ id: k.id, label: k.label, created_at: k.created_at, revoked_at: k.revoked_at ?? null, ...(tot.get(k.id) ?? {}) })) as any[];
      if (has("--json")) { process.stdout.write(JSON.stringify({ keys: rows, other: others }, null, 2) + "\n"); break; }
      if (!store.keys.length) process.stdout.write(dim(`no keys yet — apiplan keys new <label>   (${file.replace(HOME, "~")})\n`));
      else {
        process.stdout.write(`${pad(dim("ID"), 10)} ${pad(dim("LABEL"), 20)} ${pad(dim("CREATED"), 17)} ${pad(dim("REVOKED"), 17)} ${pad(dim("REQS"), 6)} ${pad(dim("TOKENS"), 12)} ${dim("COST")}\n`);
        for (const r of rows) process.stdout.write(`${pad(key(r.id), 10)} ${pad(r.label, 20)} ${pad(day(r.created_at), 17)} ${pad(r.revoked_at ? bad(day(r.revoked_at)) : dim("—"), 17)} ${pad(num(r.requests ?? 0), 6)} ${pad(num(r.total_tokens ?? 0), 12)} ${usd(r.cost_usd ?? 0)}\n`);
      }
      for (const t of others) process.stdout.write(dim(`${pad(t.key_id, 10)} ${pad("(not a store key)", 20)} ${pad("", 17)} ${pad("", 17)} ${pad(num(t.requests), 6)} ${pad(num(t.total_tokens), 12)} ${usd(t.cost_usd)}\n`));
      break;
    }
    if (action === "usage") {
      const since = valOf("--since") ?? "all";
      let windowMs = 0;
      try { windowMs = K.parseWindow(since); } catch (e: any) { die(e.message); }
      const rows = K.totalsByKey(K.readLedger(windowMs ? Date.now() - windowMs : 0));
      if (has("--json")) { process.stdout.write(JSON.stringify({ since: windowMs ? new Date(Date.now() - windowMs).toISOString() : null, ledger: K.ledgerFile(), keys: rows }, null, 2) + "\n"); break; }
      process.stdout.write(`${head("usage by key")} ${dim(since === "all" ? "· all time" : `· last ${since}`)} ${dim("· " + K.ledgerFile().replace(HOME, "~"))}\n`);
      if (!rows.length) { process.stdout.write(dim("  no requests in this window\n")); break; }
      process.stdout.write(`  ${pad(dim("KEY"), 10)} ${pad(dim("LABEL"), 18)} ${pad(dim("REQS"), 5)} ${pad(dim("ERR"), 4)} ${pad(dim("INPUT"), 9)} ${pad(dim("OUTPUT"), 9)} ${pad(dim("CACHE-R"), 9)} ${pad(dim("CACHE-W"), 9)} ${pad(dim("COST"), 11)} ${dim("LAST USED")}\n`);
      for (const t of rows) process.stdout.write(`  ${pad(key(t.key_id), 10)} ${pad(t.label, 18)} ${pad(num(t.requests), 5)} ${pad(t.errors ? bad(num(t.errors)) : "0", 4)} ${pad(num(t.input_tokens), 9)} ${pad(num(t.output_tokens), 9)} ${pad(num(t.cache_read_tokens), 9)} ${pad(num(t.cache_write_tokens), 9)} ${pad(usd(t.cost_usd), 11)} ${dim(day(t.last_used))}${t.unpriced_requests ? warn(` (${t.unpriced_requests} unpriced)`) : ""}\n`);
      break;
    }
    die("usage: apiplan keys new <label> | list | revoke <id> | usage [--since 24h|7d] [--json]");
    break;
  }
  case "serve": {
    const { serve } = await import("../src/api.ts");
    const explicitPort = valOf("--port");
    const port = explicitPort ? Number(explicitPort) : undefined;
    const s = serve({
      port,
      host: valOf("--host") ?? undefined,
      keyFile: valOf("--key-file") ?? undefined,
      keysFile: valOf("--keys-file") ?? undefined,
      cors: valOf("--cors") ?? undefined,
      reusePort: has("--reuse-port") || process.env.APIPLAN_REUSE_PORT === "1",
    });
    process.stdout.write(`${bold("apiplan api")} ${dim("v" + VERSION)} listening on ${key(s.url)} · cached tokens default\n\n`);
    process.stdout.write(`  ${dim("OpenAI SDK   ")} OPENAI_BASE_URL=${s.url}/v1\n`);
    process.stdout.write(`  ${dim("Anthropic SDK")} ANTHROPIC_BASE_URL=${s.url}\n\n`);
    process.stdout.write(dim(`  POST /v1/chat/completions · /v1/messages · /v1/audio/speech · /v1/images/generations\n`));
    process.stdout.write(dim(`  GET  /v1/models · /v1/usage · /v1/usage/keys · /health\n`));
    process.stdout.write(dim(`  any model id or alias works on either shape — \`apiplan models\` lists them\n`));
    if (!s.tokenRequired) process.stdout.write(dim(`  loopback only; set APIPLAN_SERVE_KEY_FILE (or --key-file) to require a key\n`));
    else process.stdout.write(dim(`  key required: Authorization: Bearer <key> or x-api-key: <key> · GET /health is public liveness only\n`));
    process.stdout.write(dim(`  per-key store ${s.keysFile.replace(HOME, "~")} · \`apiplan keys new <label>\` mints one · usage ledgered per key\n`));
    await new Promise(() => {});
    break;
  }
  case "daemon": {
    if (argv[1] === "stop") process.stdout.write((await daemonStop()) ? "daemon stopped\n" : "daemon not running\n");
    else await runDaemon();
    break;
  }
  case "__complete": { // hidden: shells call this on TAB — pure reads, newline list, always exit 0
    const { candidates } = await import("./completions.ts");
    const out = candidates(argv[1] ?? "", argv.slice(2));
    process.stdout.write(out.length ? out.join("\n") + "\n" : "");
    break;
  }
  case "completions": {
    const { script, SHELLS } = await import("./completions.ts");
    const sh = (argv[1] || basenameOf(process.env.SHELL || "") || "zsh") as any;
    if (!SHELLS.includes(sh)) die(`usage: apiplan completions ${SHELLS.join("|")}`);
    process.stdout.write(script(sh, C.load().commands.map((c) => c.name)));
    break;
  }
  case "shell-init": {
    // Why this exists: the SHELL expands `?` and `*` before our process starts, so
    // `opus is this right?` dies in zsh ("no matches found") no matter what we do
    // in-process. zsh's `noglob` precommand modifier fixes it, and an alias is the
    // only way to apply it automatically. bash/cmd/PowerShell pass unmatched
    // patterns through already, so they need nothing.
    const names = ["apiplan", ...C.load().commands.map((c) => c.name)];
    const shell = argv[1] || basenameOf(process.env.SHELL || "") || "zsh";
    if (/zsh/.test(shell)) {
      process.stdout.write(`# apiplan — keep ? and * literal in prompts (zsh)\n`);
      for (const n of names) process.stdout.write(`alias ${n}='noglob ${n}'\n`);
      process.stdout.write((await import("./completions.ts")).script("zsh", names.slice(1)));
    } else if (/fish/.test(shell)) {
      process.stdout.write(`# apiplan — fish expands wildcards too; quote a prompt containing ? or *\n`);
      for (const n of names) process.stdout.write(`function ${n}; command ${n} $argv; end\n`);
      process.stdout.write((await import("./completions.ts")).script("fish", names.slice(1)));
    } else {
      process.stdout.write(`# apiplan — ${shell || "sh"} passes unmatched ? and * through, so no aliases are needed.\n`);
      process.stdout.write(`# (If a file in the cwd happens to match your prompt, quote it or use --.)\n`);
      if (/bash/.test(shell)) process.stdout.write((await import("./completions.ts")).script("bash", names.slice(1)));
    }
    break;
  }
  case "path": {
    const bd = C.binDirOf(C.load());
    // --raw prints just the directory, already expanded, for scripts to compare
    // against $PATH. The default form is meant to be pasted into a shell rc.
    if (has("--raw")) { process.stdout.write(bd + "\n"); break; }
    process.stdout.write(IS_WIN ? `$env:PATH = "${bd};$env:PATH"\n` : `export PATH="${bd.replace(HOME, "$HOME")}:$PATH"\n`);
    break;
  }
  case "help": case "-h": case "--help": process.stdout.write(usage() + "\n"); break;
  case "-V": case "--version": process.stdout.write(`apiplan ${VERSION}\n`); break;
  default: process.stdout.write(usage() + "\n"); die(`unknown subcommand '${sub}'`);
}
