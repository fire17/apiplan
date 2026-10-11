// catalog-sweep.test.ts — the 2026-10-11 provider sweep (owner's ask, WA AC48A212: "see if there
// are more models at the providers that we may have missed"): Antigravity's non-Gemini chat
// models, the refresh routing that was overwriting other providers' catalogs with Codex's,
// and the new Realtime ids.
import { expect, test, describe } from "bun:test";
import { antigravityExtras, google } from "../src/providers.ts";
import { googleWireId, resolve } from "../src/registry.ts";
import { LIVE_MODELS } from "../src/live-models.ts";
import { readFileSync } from "node:fs";

// The shape fetchAvailableModels answered live on 2026-10-11 (abridged).
const LIVE = {
  "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" },
  "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
  "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)" },
  "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)" },
  "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)" },
  "gemini-3-flash": { displayName: "Gemini 3 Flash" },
  "gemini-2.5-flash": { displayName: "Gemini 3.5 Flash Lite" },
  "gemini-2.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite" },
  "gemini-3.5-flash-lite": { displayName: "Gemini 3.5 Flash Lite" },
  "gemini-2.5-flash-thinking": { displayName: "Gemini 3.5 Flash Lite" },
  "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)" },
  "gemini-3.8-flash-tiered": {},
  "gemini-3.5-flash-extra-low": { displayName: "Gemini 3.5 Flash (Low)" },
  "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" },
  "chat_20706": {},
  "tab_flash_lite_preview": {},
};

describe("antigravityExtras — Antigravity's other chat models", () => {
  const ids = antigravityExtras(LIVE, ["gemini-3.1-flash-image"]).map((e) => e.id);
  test("Claude, GPT-OSS and the plain Gemini lines are kept, behind the agy- marker", () => {
    expect(ids).toEqual(["agy-claude-opus-4-6-thinking", "agy-claude-sonnet-4-6", "agy-gemini-3-flash", "agy-gemini-3.5-flash-lite", "agy-gpt-oss-120b-medium"]);
  });
  test("effort-suffixed Gemini, wrappers, aliases, media and tab/chat ids are not", () => {
    for (const bad of ["agy-gemini-3.8-flash-low", "agy-gemini-pro-agent", "agy-gemini-3.8-flash-tiered", "agy-gemini-2.5-flash", "agy-gemini-3.1-flash-image", "agy-chat_20706"]) expect(ids).not.toContain(bad);
  });
});

describe("agy- models in the registry and on the wire", () => {
  test("the marker comes off for the wire, and the build sends that id without an effort suffix", () => {
    expect(googleWireId("agy-claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    const m = { id: "agy-claude-sonnet-4-6", provider: "google", family: "agy-claude-sonnet-4-6", version: [], label: "x", efforts: [] } as any;
    const b = google.build(m, [{ role: "user", text: "hi" }], {} as any, { token: "t" } as any);
    expect(b.body.model).toBe("claude-sonnet-4-6");
  });
  test("an effort-laddered Gemini id still gets its effort appended", () => {
    const m = resolve("gemini-3.8-flash")!;
    expect(google.build(m, [{ role: "user", text: "hi" }], { effort: "high" } as any, { token: "t" } as any).body.model).toBe("gemini-3.8-flash-high");
  });
  test("the plain Claude name keeps meaning the direct Anthropic route", () => {
    expect(resolve("claude-sonnet-4-6")?.provider).toBe("anthropic");
    expect(resolve("sonnet")?.provider).toBe("anthropic");
  });
});

describe("models --refresh routes each provider to its own catalog", () => {
  const src = readFileSync(new URL("../bin/apiplan.ts", import.meta.url), "utf8");
  test("gemini calls refreshGemini; online/grok are not fed the Codex list", () => {
    expect(src).toContain(`id === "gemini"`);
    expect(src).toContain("refreshGemini()");
    expect(src).toContain(`id !== "openai"`);
  });
});

describe("Realtime ids found live on the subscription", () => {
  test("gpt-realtime-2 and gpt-realtime-1.5 are catalogued on the Realtime WebSocket", () => {
    for (const id of ["gpt-realtime-2", "gpt-realtime-1.5"]) expect(LIVE_MODELS.find((m) => m.id === id)?.transport).toBe("realtime-websocket");
  });
});
