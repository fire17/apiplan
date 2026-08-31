#!/usr/bin/env bun
// Quality-gated vision latency/throughput benchmark.
//
// The public split is intentionally visible to an optimizer. A private split is supplied
// out-of-tree with --cases-file and is run only by the outer evaluator. The one score is
// working FPS: 1000 / p95 completion latency, but it is ZERO unless every answer is right.
//
//   bun bench/vision-bench.ts --split public --mode direct --concurrency 1
//   bun bench/vision-bench.ts --cases-file /held/out.json --mode resident --concurrency 4
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Case = {
  id: string;
  expected: string;
  prompt: string;
  draw: string[];
};

const ROOT = join(import.meta.dir, "..");
const ASK = join(ROOT, "bin", "ask.ts");
const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const MODEL = flag("--model", "gemini");
const EFFORT = flag("--effort", "low");
const MODE = flag("--mode", "direct");
const ROUTE = flag("--route", "agy");
const CONCURRENCY = Math.max(1, Number(flag("--concurrency", "1")) || 1);
const REPEATS = Math.max(1, Number(flag("--n", "1")) || 1);
const CASES_FILE = flag("--cases-file");
const OUT_JSON = args.includes("--json");

const PUBLIC: Case[] = [
  {
    id: "red-circle", expected: "red circle",
    prompt: "Name the colored shape. Answer exactly two words: COLOR SHAPE.",
    draw: ["-size", "640x480", "xc:white", "-fill", "#e31b23", "-draw", "circle 320,240 440,240"],
  },
  {
    id: "three-green-squares", expected: "3 green squares",
    prompt: "Count and name the colored shapes. Answer exactly: NUMBER COLOR SHAPES.",
    draw: ["-size", "720x420", "xc:white", "-fill", "#19a64a", "-draw", "rectangle 90,140 230,280 rectangle 290,140 430,280 rectangle 490,140 630,280"],
  },
  {
    id: "north-text", expected: "north",
    prompt: "Read the single large word. Answer with that word only.",
    // Block letters are drawn as geometry because this machine's ImageMagick has no
    // FreeType delegate; relying on -annotate produced a blank yellow image and a fake OCR
    // failure. The benchmark now verifies its stimulus by construction.
    draw: ["-size", "760x420", "xc:#f4d742", "-draw",
      "fill black rectangle 45,85 68,310 rectangle 130,85 153,310 polygon 68,85 91,85 130,310 107,310 " +
      "rectangle 185,85 285,310 fill #f4d742 rectangle 210,110 260,285 " +
      "fill black rectangle 315,85 338,310 rectangle 338,85 420,108 rectangle 338,185 410,208 rectangle 397,108 420,185 polygon 365,208 390,208 430,310 405,310 " +
      "rectangle 455,85 565,108 rectangle 498,108 522,310 " +
      "rectangle 600,85 623,310 rectangle 685,85 708,310 rectangle 623,185 685,208"],
  },
  {
    id: "right-arrow", expected: "right",
    prompt: "Which direction does the arrow point? Answer only LEFT or RIGHT.",
    draw: ["-size", "720x420", "xc:white", "-fill", "#204ecf", "-draw", "polygon 100,170 460,170 460,80 650,210 460,340 460,250 100,250"],
  },
];

function loadCases(): Case[] {
  if (!CASES_FILE) return PUBLIC;
  const value = JSON.parse(readFileSync(CASES_FILE, "utf8"));
  if (!Array.isArray(value) || !value.length) throw new Error("--cases-file must contain a non-empty JSON array");
  return value;
}

const cases = loadCases();
const runDir = join(tmpdir(), `apiplan-vision-bench-${process.pid}`);
mkdirSync(runDir, { recursive: true });

function render(c: Case): string {
  const path = join(runDir, `${c.id}.png`);
  if (existsSync(path)) return path;
  const p = Bun.spawnSync(["magick", ...c.draw, path], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`could not render ${c.id}: ${p.stderr.toString()}`);
  return path;
}

type Result = { id: string; expected: string; answer: string; ok: boolean; ms: number; code: number; error?: string };
const norm = (s: string) => s.toLowerCase()
  .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (x) => String(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].indexOf(x) + 1))
  .replace(/[^a-z0-9]+/g, " ").trim();

async function call(c: Case): Promise<Result> {
  const path = render(c);
  const argv = [process.execPath, ASK, "-m", MODEL, "-e", EFFORT, "-i", path, c.prompt];
  if (ROUTE === "public") argv.splice(4, 0, "--public");
  if (MODE === "direct") argv.splice(4, 0, "--no-daemon");
  const start = performance.now();
  const p = Bun.spawn(argv, {
    cwd: ROOT,
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...(MODE === "direct" ? { APIPLAN_DAEMON: "off" } : {}) },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const answer = out.trim();
  return {
    id: c.id, expected: c.expected, answer, code,
    ok: code === 0 && norm(answer) === norm(c.expected),
    ms: performance.now() - start,
    ...(err.trim() ? { error: err.trim().slice(0, 300) } : {}),
  };
}

const jobs: Case[] = [];
for (let n = 0; n < REPEATS; n++) jobs.push(...cases);
const results = new Array<Result>(jobs.length);
let next = 0;
const batchStart = performance.now();
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
  while (true) {
    const i = next++;
    if (i >= jobs.length) return;
    results[i] = await call(jobs[i]);
  }
}));
const wallMs = performance.now() - batchStart;

const times = results.map((r) => r.ms).sort((a, b) => a - b);
const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
const accuracy = results.filter((r) => r.ok).length / results.length;
const p50 = percentile(0.5), p95 = percentile(0.95);
const fps = accuracy === 1 ? results.length / (wallMs / 1000) : 0;
const metric = Number(fps.toFixed(6));
const report = { metric, accuracy, fps, wall_ms: wallMs, p50_ms: p50, p95_ms: p95, calls: results.length, concurrency: CONCURRENCY, route: ROUTE, mode: MODE, model: MODEL, effort: EFFORT, results };

if (OUT_JSON) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else {
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"} ${r.id.padEnd(22)} ${r.ms.toFixed(0).padStart(5)}ms  expected=${JSON.stringify(r.expected)} got=${JSON.stringify(r.answer)}${r.error ? `  ${r.error}` : ""}\n`);
  process.stdout.write(`accuracy: ${(accuracy * 100).toFixed(1)}%\n`);
  process.stdout.write(`p50_ms: ${p50.toFixed(1)}\n`);
  process.stdout.write(`p95_ms: ${p95.toFixed(1)}\n`);
  process.stdout.write(`working_fps: ${fps.toFixed(6)}\n`);
  process.stdout.write(`metric: ${metric}\n`);
}
