// 2026-09-29 (apiplan teammate, gaps-lane owner patches A/B): the LunaSight relay calls
// gpt-6-luna through `apiplan serve` with priority tier, effort none and detail low. The
// request-level knobs must survive the HTTP front (optsFrom) and a per-part OpenAI
// `image_url.detail` must survive a tool result (toolOutputOf), or the relay silently
// gets the default tier / auto detail.
import { describe, expect, test } from "bun:test";
import { optsFrom } from "../src/api.ts";
import { toolOutputOf } from "../src/responses-wire.ts";

describe("optsFrom carries the Responses speed/vision knobs", () => {
  test("body.service_tier → serviceTier", () => {
    expect(optsFrom({ service_tier: "priority" }).serviceTier).toBe("priority");
  });
  test("body.image_detail and metadata.image_detail → imageDetail", () => {
    expect(optsFrom({ image_detail: "low" }).imageDetail).toBe("low");
    expect(optsFrom({ metadata: { image_detail: "original" } }).imageDetail).toBe("original");
  });
  test("absent or empty knobs stay unset (backend default)", () => {
    const o = optsFrom({ service_tier: "", metadata: {} });
    expect(o.serviceTier).toBeUndefined();
    expect(o.imageDetail).toBeUndefined();
  });
});

describe("toolOutputOf keeps a per-part image detail", () => {
  const url = "data:image/png;base64,AAAA";
  test("OpenAI image_url.detail rides onto the input_image", () => {
    const out = toolOutputOf([{ type: "image_url", image_url: { url, detail: "low" } }]) as any[];
    expect(out).toEqual([{ type: "input_image", image_url: url, detail: "low" }]);
  });
  test("no detail given → no detail key (the global option may still set one)", () => {
    const out = toolOutputOf([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]) as any[];
    expect(out).toEqual([{ type: "input_image", image_url: url }]);
  });
});
