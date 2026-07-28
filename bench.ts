#!/usr/bin/env bun
// APIPlan bench — compare the two routes on latency (the "how fast does it respond"
// question). Fires N calls per route (optionally in parallel) and prints p50/p90/mean.
// Usage:  bun bench.ts [--model opus] [--n 5] [--parallel] [--prompt "..."]
const args = process.argv.slice(2);
const flag = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k: string) => args.includes(k);

const model = flag("--model", "haiku");
const n = +flag("--n", "5");
const parallel = has("--parallel");
const prompt = flag("--prompt", "Reply with exactly one word: pong");
const HERE = new URL(".", import.meta.url).pathname;

async function once(route: string): Promise<number> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", HERE + "api.ts", "--model", model, "--route", route, prompt],
    { stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return performance.now() - t0;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: q(0.5), p90: q(0.9), mean, min: s[0], max: s[s.length - 1] };
}

async function bench(route: string) {
  const runs = parallel
    ? await Promise.all(Array.from({ length: n }, () => once(route)))
    : await (async () => { const r: number[] = []; for (let i = 0; i < n; i++) r.push(await once(route)); return r; })();
  const st = stats(runs);
  const fmt = (x: number) => (x / 1000).toFixed(2) + "s";
  console.log(`  ${route.padEnd(8)}  p50 ${fmt(st.p50)}  p90 ${fmt(st.p90)}  mean ${fmt(st.mean)}  min ${fmt(st.min)}  max ${fmt(st.max)}`);
}

console.log(`apiplan bench — model=${model} n=${n} ${parallel ? "parallel" : "serial"}\n`);
await bench("direct");
await bench("harness");
