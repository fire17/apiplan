// image-decline.test.ts — /v1/images/generations tells a refusal from an outage (MIND report
// 2026-10-12: two "sol" refusals on srv2 surfaced as a bare 502 with the model's words dropped).
import { expect, test, describe } from "bun:test";
import { noImageError } from "../src/api.ts";
import { parseGoogleImageResponse } from "../src/providers.ts";

describe("noImageError", () => {
  test("text without an image is a 422 model_declined carrying the model's words", () => {
    const e: any = noImageError("I can't create that image because   it depicts a real person.");
    expect(e.status).toBe(422);
    expect(e.upstreamType).toBe("model_declined");
    expect(e.message).toContain(`"I can't create that image because it depicts a real person."`);
  });
  test("a long explanation is cut to 300 characters", () => {
    const e: any = noImageError("x".repeat(500));
    expect(e.message).toContain("x".repeat(300) + "…");
    expect(e.message).not.toContain("x".repeat(301));
  });
  test("no image and no text stays a 502 outage", () => {
    const e: any = noImageError("  ");
    expect(e.status).toBe(502);
    expect(e.upstreamType).toBeUndefined();
  });
});

describe("parseGoogleImageResponse keeps the model's explanation", () => {
  test("a safety block names the reason and quotes the text part", () => {
    const body = { response: { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [{ text: "I can't draw that." }] } }] } };
    expect(() => parseGoogleImageResponse(body, "m")).toThrow(`image generation stopped: IMAGE_SAFETY — "I can't draw that."`);
  });
  test("thought parts are not quoted", () => {
    const body = { response: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: "No." }] } }] } };
    expect(() => parseGoogleImageResponse(body, "m")).toThrow(`returned no image — "No."`);
  });
  test("nothing at all is the plain no-image error", () => {
    expect(() => parseGoogleImageResponse({ response: { candidates: [{}] } }, "m")).toThrow(/returned no image$/);
  });
});
