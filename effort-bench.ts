#!/usr/bin/env bun
// Effort × image benchmark — does reasoning effort change how long opus takes to
// answer about an IMAGE? Sweeps effort levels on one fixed image, measuring both
// time-to-first-token and total time, then prints a table so the effect is visible.
//
// Usage:  bun effort-bench.ts --image path/to/pic.png [--n 3] [--prompt "..."] [--model opus]
//
// Why effort affects image latency: with effort set, opus runs *adaptive thinking* —
// it reasons about the image before emitting text. Higher effort = more reasoning =
// later first token AND longer total. "no-thinking" and the -fast recipe skip it.
const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IMAGE = flag("--image", "");
if (!IMAGE) { console.error("need --image <path> (the picture to ask about)"); process.exit(1); }
const N = +flag("--n", "3");
const MODEL = flag("--model", "opus");
const PROMPT = flag("--prompt", "Describe what is in this image in one short sentence.");
const API = new URL(".", import.meta.url).pathname + "api.ts";

// Spawn a call, measure ms→first stdout byte and ms→completion. Streams so first-byte is real.
async function timeCall(extra: string[]): Promise<{ ttft: number; total: number } | null> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", API, "-m", MODEL, "-i", IMAGE, "--stream", ...extra, PROMPT], { stdout: "pipe", stderr: "pipe" });
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let ttft = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length && !ttft) ttft = performance.now() - t0;
    }
  } catch {}
  await p.exited;
  if (!ttft) return null; // no output — auth/network/model error; run one call plainly to see it
  return { ttft, total: performance.now() - t0 };
}

const CONFIGS: { label: string; extra: string[] }[] = [
  { label: "no-thinking (default)", extra: [] },
  { label: "-fast (disabled + low)", extra: ["-e", "low", "--thinking", "0"] },
  { label: "effort low", extra: ["-e", "low"] },
  { label: "effort medium", extra: ["-e", "medium"] },
  { label: "effort high", extra: ["-e", "high"] },
  { label: "effort xhigh", extra: ["-e", "xhigh"] },
  { label: "effort max", extra: ["-e", "max"] },
];

function med(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }
const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);

console.log(`effort × image bench — model=${MODEL}, image=${IMAGE}, N=${N}\nprompt=${JSON.stringify(PROMPT)}\n`);
console.log("(warming daemon…)"); await timeCall([]);

console.log(`\n  ${"config".padEnd(24)} ${"first-token (p50)".padStart(18)} ${"total (p50)".padStart(14)}`);
console.log("  " + "-".repeat(58));
for (const c of CONFIGS) {
  const runs: { ttft: number; total: number }[] = [];
  for (let i = 0; i < N; i++) { const r = await timeCall(c.extra); if (r) runs.push(r); }
  if (!runs.length) { console.log(`  ${c.label.padEnd(24)} ${"(error — run once plainly)".padStart(33)}`); continue; }
  console.log(`  ${c.label.padEnd(24)} ${fmt(med(runs.map(r => r.ttft))).padStart(18)} ${fmt(med(runs.map(r => r.total))).padStart(14)}`);
}
console.log(`\nread it: if first-token/total climb as effort rises, effort is buying reasoning-about-the-image at the cost of latency.`);
console.log(`no-thinking / -fast should be the quickest; max the slowest.`);
