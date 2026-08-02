#!/usr/bin/env bun
// apiplan.ts — the control surface: which providers am I connected to, which
// models can I call, and which commands exist on my PATH.
//
// Every capability is a headless subcommand first; the TUI is a view over those
// same functions, so anything you can click you can also script.
import { join, basename as basenameOf } from "node:path";
import { PROVIDERS, providerFor } from "../src/providers.ts";
import { models, aliasesFor, cacheAge, cacheStale, saveModels, resolve, unparseable, type Model, type ProviderId } from "../src/registry.ts";
import * as C from "../src/commands.ts";
import { osLabel, onPath, defaultBinDir, whichSync, IS_WIN, STATE_DIR, HOME } from "../src/platform.ts";
import { VERSION, daemonAlive, daemonStop, runDaemon, die } from "../src/engine.ts";

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
const ageLabel = (ms: number | null) => (ms === null ? "never refreshed" : ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);

/** Name anything the provider serves that we can't address, so nothing vanishes quietly. */
function dropNote(id: ProviderId, list: { id: string }[]): string {
  const dropped = unparseable(id, list);
  return dropped.length ? dim(` · not addressable: ${dropped.join(", ")}`) : "";
}

/** Ask each provider for its live model list. The one place that goes to the network. */
async function refreshModels(only?: ProviderId): Promise<string[]> {
  const notes: string[] = [];
  for (const id of (only ? [only] : (Object.keys(PROVIDERS) as ProviderId[]))) {
    const p = PROVIDERS[id];
    if (!p.probe().connected) { notes.push(`${id}: not connected — kept previous list`); continue; }
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
      } else {
        // Codex maintains its own authoritative cache; read it rather than re-fetch.
        const f = join(HOME, ".codex", "models_cache.json");
        const raw = JSON.parse(require("node:fs").readFileSync(f, "utf8"));
        const list = (raw.models ?? []).map((m: any) => ({
          id: m.slug ?? m.id, label: m.display_name ?? m.slug,
          efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e.effort).filter(Boolean),
        })).filter((m: any) => m.id);
        if (!list.length) throw new Error("no models in codex cache");
        saveModels(id, list);
        notes.push(`${id}: ${list.length} models from codex cache (fetched ${raw.fetched_at ?? "?"})${dropNote(id, list)}`);
      }
    } catch (e: any) { notes.push(`${id}: refresh failed — ${e?.message ?? e} (kept previous list)`); }
  }
  return notes;
}

/**
 * Speech has two distinct voice sets and the difference matters: read-aloud runs on
 * the subscription with ChatGPT's product voices, free-text speech needs a billed key
 * and uses OpenAI's API voices. Showing them together is what stops the confusion.
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
    process.stdout.write(`    ${dim(p.label)} ${dim("·")} ${dim(`${p.count} models, ${ageLabel(p.age)}`)}\n`);
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
    process.stdout.write(`\n${head(prov.toUpperCase())} ${conn ? ok("connected") : bad("not connected")} ${dim(`· ${ageLabel(cacheAge(prov as ProviderId))}${cacheStale(prov as ProviderId) ? " (stale — apiplan models --refresh)" : ""}`)}\n`);
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
  process.stdout.write(`${head("DOCTOR")}\n`);
  const rows: [string, boolean | "warn", string][] = [];
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
  rows.push(["daemon", (await daemonAlive()) ? true : "warn", (await daemonAlive()) ? "warm" : "cold (starts on first call)"]);
  for (const c of cfg.commands) {
    const h = C.health(cfg, c.name);
    rows.push([`cmd ${c.name}`, h.onPath ? true : "warn", h.onPath ? String(h.resolves).replace(HOME, "~") : h.installed ? `shadowed by ${h.resolves}` : "not installed"]);
  }
  for (const [k, state, detail] of rows) {
    process.stdout.write(`  ${state === true ? DOT_OK : state === "warn" ? DOT_WARN : DOT_BAD} ${pad(k, 22)}${dim(detail)}\n`);
  }
  const probs = rows.filter(([, s]) => s !== true).length;
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
  apiplan commands               every global command, and whether PATH finds it
  apiplan voices                 every speech voice available to you, and from where
  apiplan install                create the default command set and put it on PATH
  apiplan add <name> --model <m> [--flags "…"]      make a new command
  apiplan rename <old> <new>     rename one
  apiplan rm <name>              remove one
  apiplan sync [--force]         rebuild every shim from the config
  apiplan prune                  remove commands left over from an earlier install
  apiplan doctor                 diagnose PATH, logins, daemon, shadowed names
  apiplan update                 pull the latest apiplan, re-sync commands + models
  apiplan daemon [stop]          run or stop the warm daemon
  apiplan path                   print the line that puts commands on your PATH
  apiplan shell-init [shell]     shell glue so ? and * in a prompt need no quotes
                                 ${dim(`add to your rc:  eval "$(apiplan shell-init)"`)}

Config: ${C.configPath().replace(HOME, "~")}   ${dim("(plain JSON — safe to edit by hand, then `apiplan sync`)")}

A family name always calls the newest model in that family (${key("opus")} → newest Opus);
an explicit version is always still reachable (${key("opus48")}, ${key("sonnet46")}, ${key("gpt55")}).`;
}

const argv = process.argv.slice(2);
const sub = argv[0];
const has = (f: string) => argv.includes(f);
const valOf = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

switch (sub) {
  case undefined: await tui(); break;
  case "status": case "providers": await cmdStatus(); break;
  case "models": {
    if (has("--refresh") || has("-r")) for (const n of await refreshModels(valOf("--provider") as ProviderId | undefined)) process.stdout.write(dim(`  ${n}\n`));
    cmdModels(argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined);
    break;
  }
  case "commands": case "ls": cmdCommands(); break;
  case "voices": await cmdVoices(); break;
  case "install": {
    const cfg = C.load();
    // Seed a fresh machine, and top up an existing one with defaults added since it
    // was installed — otherwise an upgrade's new commands never reach anybody.
    const fresh = !cfg.commands.length;
    if (fresh) cfg.commands = C.defaults();
    const gained = fresh ? [] : C.mergeDefaults(cfg);
    C.save(cfg);
    if (gained.length) process.stdout.write(dim(`  new in this version: ${gained.join(" ")}\n`));
    reportSync(C.sync(cfg, { force: has("--force") }));
    break;
  }
  case "sync": {
    const cfg = C.load();
    reportSync(C.sync(cfg, { force: has("--force") }));
    const orph = C.orphans(cfg);
    if (orph.length) process.stdout.write(`${warn("!")} ${orph.length} leftover command(s) from an earlier install: ${orph.join(" ")}\n    ${dim("remove them:")} ${key("apiplan prune")}\n`);
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
  case "daemon": {
    if (argv[1] === "stop") process.stdout.write((await daemonStop()) ? "daemon stopped\n" : "daemon not running\n");
    else await runDaemon();
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
    } else if (/fish/.test(shell)) {
      process.stdout.write(`# apiplan — fish expands wildcards too; quote a prompt containing ? or *\n`);
      for (const n of names) process.stdout.write(`function ${n}; command ${n} $argv; end\n`);
    } else {
      process.stdout.write(`# apiplan — ${shell || "sh"} passes unmatched ? and * through, so no aliases are needed.\n`);
      process.stdout.write(`# (If a file in the cwd happens to match your prompt, quote it or use --.)\n`);
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
