#!/usr/bin/env bun
// Image-size sweep — does a bigger/higher-res image take longer to answer about?
// Fixed model + effort (isolates size); N runs per image; reports median + min–max.
// Usage: bun size-bench.ts --images a.png,b.png,... [--n 5] [--model opus]
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IMAGES = flag("--images", "").split(",").filter(Boolean);
const N = +flag("--n", "5");
const MODEL = flag("--model", "opus");
const PROMPT = flag("--prompt", "Describe what is in this image in one short sentence.");
const API = new URL(".", import.meta.url).pathname + "api.ts";
if (!IMAGES.length) { console.error("need --images a.png,b.png,..."); process.exit(1); }

function pngInfo(path: string) {
  const b = readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20); // IHDR width/height
  return { dims: `${w}x${h}`, kb: Math.round(b.byteLength / 1024) };
}
async function timeCall(image: string): Promise<{ ttft: number; total: number } | null> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", API, "-m", MODEL, "--stream", "-i", image, PROMPT], { stdout: "pipe", stderr: "pipe" });
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  let ttft = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value?.length && !ttft) ttft = performance.now() - t0; } } catch {}
  await p.exited;
  return ttft ? { ttft, total: performance.now() - t0 } : null;
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
const cell = (xs: number[]) => `${fmt(med(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})`;

console.log(`image-size sweep — model=${MODEL}, effort=none, N=${N} per image\n`);
console.log("(warming daemon…)"); const w = Bun.spawn(["bun", API, "-m", MODEL, "--stream", "hi"], { stdout: "pipe", stderr: "pipe" }); await w.exited;
console.log(`  ${"image".padEnd(16)} ${"first-token (med, range)".padStart(26)} ${"total (med, range)".padStart(26)}`);
console.log("  " + "-".repeat(70));
for (const img of IMAGES) {
  const info = pngInfo(img);
  const runs: { ttft: number; total: number }[] = [];
  for (let i = 0; i < N; i++) { const r = await timeCall(img); if (r) runs.push(r); }
  const label = `${info.dims} ${info.kb}KB`;
  if (!runs.length) { console.log(`  ${label.padEnd(16)} ${"(error)".padStart(26)}`); continue; }
  console.log(`  ${label.padEnd(16)} ${cell(runs.map(r => r.ttft)).padStart(26)} ${cell(runs.map(r => r.total)).padStart(26)}`);
}
console.log(`\ndone.`);
