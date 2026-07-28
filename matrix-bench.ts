#!/usr/bin/env bun
// Matrix bench — effort {none,low,high,xhigh} × mode {text-only, with-image} on one model.
// Measures ms→first-token and ms→completion, N runs each, prints two tables.
// Usage: bun matrix-bench.ts --image pic.png [--n 4] [--model opus]
const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IMAGE = flag("--image", "");
const N = +flag("--n", "4");
const MODEL = flag("--model", "opus");
const P_TEXT = flag("--prompt-text", "Name three prime numbers between 10 and 40. One short sentence.");
const P_IMG = flag("--prompt-image", "Describe what is in this image in one short sentence.");
const API = new URL(".", import.meta.url).pathname + "api.ts";

async function timeCall(extra: string[], prompt: string): Promise<{ ttft: number; total: number } | null> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", API, "-m", MODEL, "--stream", ...extra, prompt], { stdout: "pipe", stderr: "pipe" });
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let ttft = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value?.length && !ttft) ttft = performance.now() - t0; } } catch {}
  await p.exited;
  return ttft ? { ttft, total: performance.now() - t0 } : null;
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
const cell = (xs: number[]) => `${fmt(med(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})`;
const EFFORTS = [{ label: "none (no thinking)", e: [] as string[] }, { label: "low", e: ["-e", "low"] }, { label: "high", e: ["-e", "high"] }, { label: "xhigh", e: ["-e", "xhigh"] }];

async function table(title: string, imageArgs: string[], prompt: string) {
  console.log(`\n### ${title}   (median, with min–max range, N=${N})`);
  console.log(`  ${"effort".padEnd(20)} ${"first-token".padStart(22)} ${"total".padStart(22)}`);
  console.log("  " + "-".repeat(66));
  for (const cfg of EFFORTS) {
    const runs: { ttft: number; total: number }[] = [];
    for (let i = 0; i < N; i++) { const r = await timeCall([...cfg.e, ...imageArgs], prompt); if (r) runs.push(r); }
    if (!runs.length) { console.log(`  ${cfg.label.padEnd(20)} ${"(error)".padStart(22)}`); continue; }
    console.log(`  ${cfg.label.padEnd(20)} ${cell(runs.map(r => r.ttft)).padStart(22)} ${cell(runs.map(r => r.total)).padStart(22)}`);
  }
}

console.log(`matrix bench — model=${MODEL}, N=${N}, image=${IMAGE || "(none)"}`);
console.log("(warming daemon…)"); await timeCall([], "hi");
await table("TEXT-ONLY", [], P_TEXT);
if (IMAGE) await table("WITH IMAGE", ["-i", IMAGE], P_IMG);
console.log(`\ndone.`);
