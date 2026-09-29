// providers-gpt6.test.ts — the openai (Codex Responses) build path on GPT-6 (2026-09-29).
// Pure: no network. Live receipts for every wire value asserted here are in the lane report
// (gpt-6-luna, APIPLAN_CODEX_CLIENT_VERSION=0.158.0):
//   service_tier  priority/default → 200 · fast/flex/auto → 400 "Unsupported service_tier"
//   detail        low/high/auto/original → 200 · banana → 400 (supported list = those four)
//   effort        none → 200 on luna · none → 400 on astra · minimal → 400 on luna
//   tool_result   red PNG inside an Anthropic tool_result → gpt-6-luna answers "Red"
import { afterEach, describe, expect, test } from "bun:test";
import { openai, openaiServiceTier, withImageDetail, type CallOpts, type Turn } from "../src/providers.ts";
import type { Model } from "../src/registry.ts";

const CREDS = { token: "t", account: "a", source: "test" };
const LUNA = { id: "gpt-6-luna", provider: "openai", label: "GPT-6-Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"] } as unknown as Model;
const ASTRA = { id: "gpt-6-astra", provider: "openai", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max"] } as unknown as Model;
const IMG = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };

const toolTurns = (): Turn[] => [
  { role: "user", text: "look" },
  { role: "assistant", text: "", toolUses: [{ id: "c1", name: "screenshot", input: {} }] },
  { role: "user", text: "", toolResults: [{ toolUseId: "c1", content: [{ type: "text", text: "shot" }, IMG] }] },
];
const build = (o: CallOpts, turns: Turn[] = [{ role: "user", text: "hi" }], m = LUNA) => openai.build(m, turns, o, CREDS).body;

const saved = { tier: process.env.APIPLAN_SERVICE_TIER, detail: process.env.APIPLAN_IMAGE_DETAIL };
afterEach(() => {
  for (const [k, v] of [["APIPLAN_SERVICE_TIER", saved.tier], ["APIPLAN_IMAGE_DETAIL", saved.detail]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("tool_result images reach the Responses body (not '[image]')", () => {
  test("an Anthropic image inside a tool_result becomes an input_image part", () => {
    const out = build({}, toolTurns()).input.find((it: any) => it.type === "function_call_output");
    expect(out.output).toEqual([{ type: "input_text", text: "shot" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }]);
    expect(JSON.stringify(out)).not.toContain("[image]");
  });
});

describe("service_tier passthrough", () => {
  test("absent by default", () => { delete process.env.APIPLAN_SERVICE_TIER; expect(build({}).service_tier).toBeUndefined(); });
  test("explicit option wins; 'fast' is the Codex word for priority", () => {
    expect(build({ serviceTier: "priority" }).service_tier).toBe("priority");
    expect(build({ serviceTier: "Fast" }).service_tier).toBe("priority");
    expect(build({ serviceTier: "default", fast: true }).service_tier).toBe("default");
  });
  test("--fast implies priority on openai", () => { expect(build({ fast: true }).service_tier).toBe("priority"); });
  test("env APIPLAN_SERVICE_TIER is the fallback", () => {
    process.env.APIPLAN_SERVICE_TIER = "priority";
    expect(build({}).service_tier).toBe("priority");
    expect(openaiServiceTier({ serviceTier: "default" })).toBe("default");
  });
  test("unknown values pass through so the backend's 400 names them", () => {
    expect(openaiServiceTier({ serviceTier: "flex" })).toBe("flex");
  });
});

describe("image detail passthrough", () => {
  test("absent by default", () => {
    delete process.env.APIPLAN_IMAGE_DETAIL;
    expect(JSON.stringify(build({}, toolTurns()))).not.toContain('"detail"');
  });
  test("tags tool-result images AND user images", () => {
    const turns: Turn[] = [{ role: "user", text: "a", images: [{ mediaType: "image/png", base64: "BBB" }] }, ...toolTurns().slice(1)];
    const body = build({ imageDetail: "original" }, turns);
    const imgs = body.input.flatMap((it: any) => (it.type === "message" ? it.content : Array.isArray(it.output) ? it.output : []))
      .filter((p: any) => p.type === "input_image");
    expect(imgs.length).toBe(2);
    for (const p of imgs) expect(p.detail).toBe("original");
  });
  test("env APIPLAN_IMAGE_DETAIL is the fallback; option wins", () => {
    process.env.APIPLAN_IMAGE_DETAIL = "low";
    const img = (b: any) => b.input.find((it: any) => it.type === "function_call_output").output[1];
    expect(img(build({}, toolTurns())).detail).toBe("low");
    expect(img(build({ imageDetail: "high" }, toolTurns())).detail).toBe("high");
  });
  test("a part that already names its detail keeps it; text parts untouched", () => {
    const input = [{ type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "u", detail: "low" }, { type: "input_text", text: "t" }] }];
    withImageDetail(input, "high");
    expect(input[0].output).toEqual([{ type: "input_image", image_url: "u", detail: "low" }, { type: "input_text", text: "t" }]);
  });
});

describe("effort none + thinking off", () => {
  test("effort 'none' is sent as-is on gpt-6-luna", () => {
    expect(build({ effort: "none" }).reasoning).toEqual({ effort: "none" });
  });
  test("thinkOff → the bottom of the model's own ladder, overriding a paired effort", () => {
    expect(build({ thinkOff: true }).reasoning).toEqual({ effort: "none" });
    expect(build({ thinkOff: true, effort: "xhigh" }).reasoning).toEqual({ effort: "none" });
    // astra 400s 'none' live, so its floor is its own lowest listed level
    expect(build({ thinkOff: true }, undefined, ASTRA).reasoning).toEqual({ effort: "low" });
  });
  test("thinkOff with no ladder falls back to the caller's effort / backend default", () => {
    const bare = { id: "x", provider: "openai", label: "x", efforts: [] } as unknown as Model;
    expect(openai.build(bare, [{ role: "user", text: "hi" }], { thinkOff: true }, CREDS).body.reasoning).toBeUndefined();
  });
  test("no thinkOff, no effort → no reasoning field (unchanged)", () => {
    expect(build({}).reasoning).toBeUndefined();
  });
});
