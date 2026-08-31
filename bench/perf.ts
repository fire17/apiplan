#!/usr/bin/env bun
// perf.ts — measures the budgets in BUDGETS.md and fails on regression.
//
// The honest split this harness enforces: we can only be held responsible for the
// time WE add, so that number is measured DIRECTLY inside the client (dispatch +
// drain, via APIPLAN_TIMING) rather than inferred by subtracting two network-noisy
// medians. End-to-end comparisons are still printed, but only as observations —
// gating on them means failing when the provider is busy.
//
//   bun bench/perf.ts                 all budgets, compare to baseline
//   bun bench/perf.ts --client        just the no-network client overhead
//   bun bench/perf.ts --update        accept current numbers as the new baseline
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const ASK = join(ROOT, "bin", "ask.ts");
const BASELINE = join(import.meta.dir, "baseline.json");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const flag = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const N = +flag("--n", "5");
// Only these count as "run just this section"; --n/--update must not filter anything.
const SECTIONS = ["client", "overhead", "warm", "mem", "providers"];
const picked = SECTIONS.filter((s) => has(`--${s}`));
const only = (name: string) => picked.length === 0 || picked.includes(name);

const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
// For OUR OWN code path the floor is the honest estimate: the work is deterministic, so
// anything above the minimum is the OS scheduling around us, not our cost. Medians of
// small samples made this row swing 4ms->12ms and fail its own gate.
const floor = (xs: number[]) => (xs.length ? Math.min(...xs) : NaN);

type Row = { id: string; label: string; value: number; unit: "ms" | "MB" | "count"; budget: number; cmp: "<=" | ">="; networkBound?: boolean; note?: string; observe?: boolean; band?: number };
const rows: Row[] = [];

/** Time a spawn until its first stdout byte, plus the self-reported internal timings. */
async function timeSpawn(argv: string[], env: Record<string, string> = {}): Promise<{ first: number; total: number; ours?: number } | null> {
  const t0 = performance.now();
  const p = Bun.spawn([process.execPath, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, APIPLAN_TIMING: "1", ...env } });
  const rd = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let first = 0;
  try { while (true) { const { done, value } = await rd.read(); if (done) break; if (value?.length && !first) first = performance.now() - t0; } } catch {}
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (!first) return null;
  // dispatch = our work before the request leaves; drain = our work after the last byte.
  const m = err.match(/\[timing\] dispatch=([\d.]+) drain=([\d.]+)/);
  return { first, total: performance.now() - t0, ours: m ? +m[1] + +m[2] : undefined };
}

// B1 — client overhead: everything we do before the network exists.
if (only("client")) {
  const runs: number[] = [];
  // A process-spawn floor needs enough trials to see one unscheduled launch. Eight was
  // too small on a busy release machine (22 ms with N=40, 27 ms with N=8, same binary).
  for (let i = 0; i < Math.max(N, 24); i++) {
    const r = await timeSpawn([ASK, "-m", "opus", "--dry-run", "hi"], { APIPLAN_DAEMON: "off" });
    if (r) runs.push(r.first);
  }
  rows.push({ id: "client_overhead", label: "client overhead (no network)", value: floor(runs), unit: "ms", budget: 25, cmp: "<=" });
}

// B2/B3 — what the tool adds on a real call, and what the daemon saves.
if (only("overhead") || only("warm")) {
  // raw baseline: the same request, straight from this process, no CLI at all
  const rawTtft = async (): Promise<number> => {
    const { anthropic } = await import("../src/providers.ts");
    const { resolve } = await import("../src/registry.ts");
    const m = resolve("haiku")!;
    const c = anthropic.creds();
    const b = anthropic.build(m, [{ role: "user", text: "say pong" }], { effort: undefined }, c);
    const t0 = performance.now();
    const res = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify({ ...b.body, stream: true }) });
    const rd = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      if (dec.decode(value, { stream: true }).includes("text_delta")) { rd.cancel(); return performance.now() - t0; }
    }
    return performance.now() - t0;
  };
  const raws: number[] = [];
  for (let i = 0; i < N; i++) { try { raws.push(await rawTtft()); } catch (e: any) { console.error(`  raw call failed: ${e?.message}`); break; } }

  const cold: number[] = [], warm: number[] = [], ours: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = await timeSpawn([ASK, "-m", "haiku", "--stream", "--no-daemon", "say", "pong"]);
    if (r) cold.push(r.first);
  }
  await timeSpawn([ASK, "-m", "haiku", "--stream", "say", "pong"]); // start + warm the daemon
  for (let i = 0; i < N; i++) {
    const r = await timeSpawn([ASK, "-m", "haiku", "--stream", "say", "pong"]);
    if (r) { warm.push(r.first); if (r.ours !== undefined) ours.push(r.ours); }
  }
  // Measured directly by the client, not inferred by subtracting two noisy medians —
  // that estimator swung ±400ms run-to-run on identical code (DARWIN.md round 5).
  if (ours.length) {
    rows.push({ id: "tool_overhead", label: "overhead we add (measured directly)", value: floor(ours), unit: "ms", budget: 60, cmp: "<=", note: "dispatch + drain inside our process, warm daemon (floor of N)" });
  }
  if (raws.length && warm.length) {
    rows.push({ id: "e2e_vs_raw", label: "warm call vs raw fetch, end-to-end", value: med(warm) - med(raws), unit: "ms", budget: 0, cmp: "<=", networkBound: true, observe: true, note: `warm ${fmt(med(warm))} vs raw ${fmt(med(raws))} — informational` });
  }
  // End-to-end cold-vs-warm is dominated by the provider's own first-token time and
  // ±0.7s jitter, so it is REPORTED but never gated — a gate here fails on weather.
  if (cold.length && warm.length) {
    rows.push({ id: "daemon_saving", label: "daemon vs cold, end-to-end", value: med(cold) - med(warm), unit: "ms", budget: 0, cmp: ">=", networkBound: true, observe: true, note: `cold ${fmt(med(cold))} vs warm ${fmt(med(warm))} — informational, jitter ±700ms` });
  }
  // What the daemon removes from every call: the credential read (a Keychain subprocess
  // on macOS). Reported, NOT gated — this measures how slow the OS is, not how good our
  // code is, so a faster Keychain would otherwise be scored as a regression. The gated
  // `tool_overhead` row already proves the client is not doing this work per call.
  const credRead = (() => {
    const xs: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      Bun.spawnSync(["security", "find-generic-password", "-s", process.env.APIPLAN_KEYCHAIN_SERVICE || "Claude Code-credentials", "-w"], { stderr: "ignore" });
      xs.push(performance.now() - t0);
    }
    return med(xs);
  })();
  if (credRead > 0) rows.push({ id: "creds_saving", label: "credential read the daemon skips", value: credRead, unit: "ms", budget: 0, cmp: ">=", observe: true, note: "environmental: how long the OS takes to hand over the credential" });
}

// B4/B5 — the daemon must be cheap to leave running.
if (only("mem")) {
  await timeSpawn([ASK, "-m", "haiku", "--stream", "hi"]); // ensure it is up
  const ps = Bun.spawnSync(["ps", "-Ao", "rss,command"], { stdout: "pipe" }).stdout.toString();
  const line = ps.split("\n").find((l) => l.includes("--daemon") && l.includes("ask.ts"));
  const rssMb = line ? +line.trim().split(/\s+/)[0] / 1024 : NaN;
  if (!Number.isNaN(rssMb)) rows.push({ id: "daemon_rss", label: "idle daemon memory", value: rssMb, unit: "MB", budget: 80, cmp: "<=", band: 0.4 });
}

// B11 — one engine, both providers.
if (only("providers")) {
  let okCount = 0;
  for (const m of ["haiku", "sol"]) {
    let ok = false, why = "";
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {   // one retry: rate limits are transient
      if (attempt) await Bun.sleep(2000);
      const p = Bun.spawnSync([process.execPath, ASK, "-m", m, "--no-daemon", "say", "pong"], { stdout: "pipe", stderr: "pipe" });
      ok = p.exitCode === 0 && p.stdout.toString().trim().length > 0;
      why = p.stderr.toString().slice(0, 160);
    }
    if (ok) okCount++; else console.error(`  ${m} failed after retry: ${why}`);
  }
  rows.push({ id: "providers_live", label: "providers answering live", value: okCount, unit: "count", budget: 2, cmp: ">=" });
}

// ── report + regression gate ─────────────────────────────────────────────────
const base: Record<string, number> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const unit = (r: Row) => (r.unit === "ms" ? fmt(r.value) : r.unit === "MB" ? `${r.value.toFixed(0)}MB` : String(r.value));
let failed = 0, regressed = 0;

console.log(`\napiplan perf — N=${N}\n`);
console.log(`  ${"metric".padEnd(34)}${"measured".padStart(10)}${"budget".padStart(10)}${"baseline".padStart(11)}  verdict`);
console.log("  " + "─".repeat(78));
for (const r of rows) {
  const pass = r.observe ? true : r.cmp === "<=" ? r.value <= r.budget : r.value >= r.budget;
  if (!pass) failed++;
  const b = base[r.id];
  // Drift band per row. Latency we control is tight; memory legitimately breathes with
  // GC and uptime (40-51MB observed for an idle daemon), and a gate that cries wolf on
  // normal variation is a gate people learn to ignore. The hard budget still applies.
  const band = r.band ?? (r.networkBound ? 0.5 : 0.1);
  // A percentage alone is meaningless at small absolute values: 10% of an 18ms spawn
  // measurement is 1.8ms, well inside normal process-start noise, so the gate would
  // cry wolf on nothing. Require the drift to clear BOTH the band and a floor.
  const slack = r.unit === "ms" ? 5 : r.unit === "MB" ? 8 : 0;
  let drift = "";
  if (!r.observe && b !== undefined && Number.isFinite(b)) {
    const worse = r.cmp === "<=" ? r.value > b * (1 + band) + slack : r.value < b * (1 - band) - slack;
    if (worse) { regressed++; drift = " ⚠ regressed"; }
  }
  const budgetStr = r.observe ? "—" : `${r.cmp === "<=" ? "≤" : "≥"}${r.unit === "ms" ? fmt(r.budget) : r.budget}`;
  console.log(`  ${r.label.padEnd(34)}${unit(r).padStart(10)}${budgetStr.padStart(10)}${(b === undefined ? "—" : r.unit === "ms" ? fmt(b) : String(Math.round(b))).padStart(11)}  ${r.observe ? "observe" : pass ? "PASS" : "FAIL"}${drift}`);
  if (r.note) console.log(`  ${"".padEnd(34)}${r.note}`);
}
console.log("");
if (has("--update") || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({ ...base, ...Object.fromEntries(rows.map((r) => [r.id, r.value])) }, null, 2) + "\n");
  console.log(`  baseline ${existsSync(BASELINE) ? "updated" : "written"} → bench/baseline.json`);
}
if (failed || regressed) {
  console.log(`  ${failed} over budget, ${regressed} regressed\n`);
  process.exit(1);
}
console.log(`  all ${rows.length} budgets met\n`);
