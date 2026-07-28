#!/usr/bin/env bun
// TTFT research loop — measures true time-to-first-token (wall time from launching
// the CLI to the first byte of output) across a config matrix, then ranks the winners.
// It also measures pure client overhead via --dry-run (no network), so you can SEE how
// much of TTFT is client (language-addressable) vs network+server (physics, not ours).
//
// Usage:  bun ttft-bench.ts [--n 8] [--prompt "count from 1 to 40"]
// The loop: warm the daemon → sweep {model × fast × warm/cold} → N runs each →
// report min / p50 first-byte latency, sorted fastest-first, with the client-overhead
// floor called out so you know the irreducible network+server remainder.
const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = +flag("--n", "8");
const PROMPT = flag("--prompt", "count from 1 to 40, one number per line");
const API = new URL(".", import.meta.url).pathname + "api.ts";

// Time from spawn to first stdout byte. Kills the process once the first byte lands —
// we only care about TTFT, not full generation. dryRun rows never hit the network.
async function firstByteMs(extra: string[]): Promise<number | null> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", API, ...extra, PROMPT], { stdout: "pipe", stderr: "pipe" });
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) { const dt = performance.now() - t0; p.kill(); return dt; }
    }
  } catch {}
  await p.exited;
  return null; // died before emitting (auth/network error) — check with a plain call
}

function stats(xs: number[]) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p50: q(0.5), n: s.length };
}

const CONFIGS: { label: string; extra: string[] }[] = [
  { label: "client-only (dry-run, no network)", extra: ["--model", "haiku", "--dry-run"] },
  { label: "haiku  warm  (effort low, thinking 0, stream)", extra: ["--model", "haiku", "--effort", "low", "--thinking", "0", "--stream"] },
  { label: "haiku  cold  (--no-daemon)", extra: ["--model", "haiku", "--effort", "low", "--thinking", "0", "--stream", "--no-daemon"] },
  { label: "sonnet warm", extra: ["--model", "sonnet", "--effort", "low", "--thinking", "0", "--stream"] },
  { label: "opus   warm", extra: ["--model", "opus", "--effort", "low", "--thinking", "0", "--stream"] },
  { label: "opus   warm  --fast", extra: ["--model", "opus", "--effort", "low", "--thinking", "0", "--stream", "--fast"] },
];

console.log(`TTFT research loop — N=${N} per config, prompt=${JSON.stringify(PROMPT)}\n`);
console.log("warming daemon…");
await firstByteMs(["--model", "haiku", "--effort", "low", "--thinking", "0", "--stream"]); // spins up + warms the connection

const rows: { label: string; s: ReturnType<typeof stats> }[] = [];
for (const c of CONFIGS) {
  const runs: number[] = [];
  for (let i = 0; i < N; i++) { const t = await firstByteMs(c.extra); if (t != null) runs.push(t); }
  rows.push({ label: c.label, s: stats(runs) });
}

const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`);
const client = rows.find((r) => r.label.startsWith("client-only"))?.s?.min ?? 0;

console.log("\nresults (fastest first-byte first):\n");
const sorted = [...rows].sort((a, b) => (a.s?.min ?? 1e9) - (b.s?.min ?? 1e9));
for (const r of sorted) {
  if (!r.s) { console.log(`  ${r.label.padEnd(44)}  (no output — auth/network error?)`); continue; }
  const net = r.label.startsWith("client-only") ? 0 : Math.max(0, r.s.min - client);
  console.log(`  ${r.label.padEnd(44)}  min ${fmt(r.s.min).padStart(7)}  p50 ${fmt(r.s.p50).padStart(7)}` +
    (net ? `   (~${fmt(net)} is network+server, not ours)` : `   ← client floor (language-addressable)`));
}
console.log(`\nread it: client overhead ≈ ${fmt(client)} (a native client could cut this to ~1-3ms).`);
console.log("everything above that floor is network round-trip + Anthropic's model — physics, not the CLI.");
