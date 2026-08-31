#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callGeminiPublic } from "../src/gemini-media.ts";
import { mapOrdered } from "../src/vision-pipeline.ts";
import { resolveModelOrDie } from "../src/engine.ts";

type Frame = { seq: number; timestampMs: number; path: string };

const value = (args: string[], name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? fallback : fallback;
};

export async function runVisionCLI(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`apiplan vision <video> [options]\n\n` +
      `  --fps <n>           sample rate sent to the model (default 1)\n` +
      `  --concurrency <n>   bounded parallel calls (default 4)\n` +
      `  --model <name>      Gemini model/alias (default gemini)\n` +
      `  --effort <level>    low | medium | high (default low)\n` +
      `  --prompt <text>     per-frame question\n\n` +
      `Emits one JSON object per sampled frame, always in timestamp order.\n` +
      `This measured pipeline uses the public Gemini key route.\n`);
    return;
  }
  const file = args.find((x, i) => i === 0 && !x.startsWith("-"));
  if (!file || !existsSync(file)) throw new Error(`video not found: ${file ?? "(missing)"}`);
  const fps = Math.max(0.01, Number(value(args, "--fps", "1")) || 1);
  const concurrency = Math.max(1, Number(value(args, "--concurrency", "4")) || 4);
  const effort = value(args, "--effort", "low");
  const prompt = value(args, "--prompt", "Describe the visible action or change in one terse sentence.");
  const model = resolveModelOrDie(value(args, "--model", "gemini"));
  if (model.provider !== "google") throw new Error("the measured vision pipeline currently requires a Gemini model");

  const dir = mkdtempSync(join(tmpdir(), "apiplan-vision-"));
  try {
    const extraction = Bun.spawnSync([
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", file,
      "-vf", `fps=${fps}`, "-q:v", "3", join(dir, "frame-%08d.jpg"),
    ], { stdout: "pipe", stderr: "pipe" });
    if (extraction.exitCode !== 0) throw new Error(`ffmpeg could not sample the video: ${extraction.stderr.toString().trim()}`);
    const paths = readdirSync(dir).filter((x) => x.endsWith(".jpg")).sort();
    const frames: Frame[] = paths.map((name, i) => ({ seq: i, timestampMs: Math.round(i * 1000 / fps), path: join(dir, name) }));
    if (!frames.length) throw new Error("ffmpeg extracted no frames");

    const stats = await mapOrdered(frames, concurrency, async (frame) => {
      const bytes = readFileSync(frame.path);
      const r = await callGeminiPublic(model.id, [{
        role: "user", text: prompt,
        images: [{ mediaType: "image/jpeg", base64: bytes.toString("base64") }],
      }], { effort: effort as any });
      return { text: r.text.trim(), model: r.model, ttftMs: r.ttft, totalMs: r.total };
    }, (outcome) => {
      process.stdout.write(JSON.stringify({
        seq: outcome.seq,
        timestampMs: outcome.item.timestampMs,
        ...(outcome.value ?? {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        latencyMs: outcome.latencyMs,
      }) + "\n");
    });
    process.stderr.write(`[apiplan vision] sampled=${stats.accepted} completed=${stats.completed} emitted=${stats.emitted} failed=${stats.failed} max_in_flight=${stats.maxInFlight} throughput_fps=${(stats.emitted / (stats.wallMs / 1000)).toFixed(3)}\n`);
  } finally {
    // Exact directory created above; sampled frames are reproducible from the source video.
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) runVisionCLI().catch((e) => { process.stderr.write(`apiplan vision: ${e?.message ?? e}\n`); process.exit(1); });
