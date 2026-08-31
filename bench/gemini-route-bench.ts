#!/usr/bin/env bun
// Compare the same Gemini vision question through the public API-key route and AGY's
// Cloud Code subscription route. Secrets are read into headers and never printed/argv'd.
//
//   bun bench/gemini-route-bench.ts --image frame.jpg --n 3
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { google } from "../src/providers.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback = "") => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const image = flag("--image");
const n = Math.max(1, Number(flag("--n", "3")) || 3);
const prompt = flag("--prompt", "Answer with exactly two words naming the central shape and its color.");
const keyFile = flag("--key-file", join(process.env.HOME ?? "", ".config", "gemini", "api_key"));
if (!image) throw new Error("--image is required");

const bytes = readFileSync(image);
const mediaType = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
const data = bytes.toString("base64");
const apiKey = (process.env.APIPLAN_GEMINI_API_KEY ?? readFileSync(keyFile, "utf8")).trim();
if (!apiKey) throw new Error("public Gemini API key is empty");
await google.prepare?.();
const agyCreds = google.creds();
const model: any = { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "google", efforts: ["low", "medium", "high"] };
const turns: any[] = [{ role: "user", text: prompt, images: [{ mediaType, base64: data }] }];

type Sample = { route: "public" | "agy"; status: number; ttft_ms: number; total_ms: number; answer: string; model?: string };

async function readSse(route: Sample["route"], res: Response, started: number): Promise<Sample> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", ttft = 0, served = "";
  const event = (raw: string) => {
    const payload = raw.split(/\r?\n/).filter((x) => x.startsWith("data:")).map((x) => x.slice(5).trim()).join("\n");
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try { j = JSON.parse(payload); } catch { return; }
    const r = j?.response ?? j;
    served = r?.modelVersion ?? served;
    for (const p of r?.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p?.text === "string" && !p.thought) {
        if (!ttft) ttft = performance.now() - started;
        answer += p.text;
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i);
      const sep = buf.slice(i).match(/^\r?\n\r?\n/)![0].length;
      buf = buf.slice(i + sep);
      event(raw);
    }
  }
  if (buf.trim()) event(buf);
  return { route, status: res.status, ttft_ms: ttft || performance.now() - started, total_ms: performance.now() - started, answer: answer.trim(), ...(served ? { model: served } : {}) };
}

async function publicCall(): Promise<Sample> {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mediaType, data } }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
  };
  const started = performance.now();
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse", {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`public route ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return readSse("public", res, started);
}

async function agyCall(): Promise<Sample> {
  const b = google.build(model, turns, { effort: "low" }, agyCreds);
  const started = performance.now();
  const res = await fetch(b.url, { method: "POST", headers: b.headers, body: JSON.stringify(b.body) });
  if (!res.ok) throw new Error(`AGY route ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return readSse("agy", res, started);
}

const samples: Sample[] = [];
for (let i = 0; i < n; i++) {
  // Interleave to make time-of-day provider load less able to bias one whole route.
  samples.push(i % 2 ? await agyCall() : await publicCall());
  samples.push(i % 2 ? await publicCall() : await agyCall());
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
for (const s of samples) console.log(`${s.route.padEnd(6)} ttft=${s.ttft_ms.toFixed(0).padStart(5)}ms total=${s.total_ms.toFixed(0).padStart(5)}ms answer=${JSON.stringify(s.answer)} model=${s.model ?? "?"}`);
for (const route of ["public", "agy"] as const) {
  const rs = samples.filter((s) => s.route === route);
  console.log(`${route}_median_ttft_ms: ${median(rs.map((s) => s.ttft_ms)).toFixed(1)}`);
  console.log(`${route}_median_total_ms: ${median(rs.map((s) => s.total_ms)).toFixed(1)}`);
}
