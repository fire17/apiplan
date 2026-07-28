// Alias resolution is the contract the vision cares most about:
//   a family name means the NEWEST model of that family,
//   an explicit version is ALWAYS still reachable.
import { expect, test, describe } from "bun:test";
import { resolve, models, norm, aliasesFor } from "../src/registry.ts";

const id = (name: string) => resolve(name)?.id ?? null;

describe("family aliases follow the newest model", () => {
  test("opus is Opus 5, not 4.8", () => {
    expect(id("opus")).toBe("claude-opus-5");
  });
  test("sonnet, fable, haiku, gpt resolve to their newest", () => {
    expect(id("sonnet")).toBe("claude-sonnet-5");
    expect(id("fable")).toBe("claude-fable-5");
    expect(id("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(id("gpt")).toBe("gpt-5.6-sol");
  });
});

describe("explicit versions stay reachable", () => {
  test.each([
    ["opus5", "claude-opus-5"],
    ["opus48", "claude-opus-4-8"],
    ["opus47", "claude-opus-4-7"],
    ["opus46", "claude-opus-4-6"],
    ["opus45", "claude-opus-4-5-20251101"],
    ["opus41", "claude-opus-4-1-20250805"],
    ["sonnet5", "claude-sonnet-5"],
    ["sonnet46", "claude-sonnet-4-6"],
    ["sonnet45", "claude-sonnet-4-5-20250929"],
    ["haiku45", "claude-haiku-4-5-20251001"],
    ["fable5", "claude-fable-5"],
    ["gpt55", "gpt-5.5"],
    ["gpt54", "gpt-5.4"],
    ["gpt54mini", "gpt-5.4-mini"],
  ])("%s → %s", (alias, want) => {
    expect(id(alias)).toBe(want);
  });
});

describe("humans type versions many ways", () => {
  test.each(["opus4.8", "opus-4-8", "Opus4.8", "OPUS_4_8", "opus 4.8"])("%s → claude-opus-4-8", (v) => {
    expect(id(v)).toBe("claude-opus-4-8");
  });
  test("normalisation folds separators and case", () => {
    expect(norm("Opus-4.8")).toBe("opus48");
  });
});

describe("variants", () => {
  test.each([["sol", "gpt-5.6-sol"], ["luna", "gpt-5.6-luna"], ["terra", "gpt-5.6-terra"]])("%s → %s", (a, want) => {
    expect(id(a)).toBe(want);
  });
  test("a bare generation picks that generation's flagship", () => {
    expect(id("gpt56")).toBe("gpt-5.6-sol");
  });
  test("codex means the OpenAI coding model", () => {
    expect(resolve("codex")?.provider).toBe("openai");
  });
});

describe("ids and unknowns", () => {
  test("a full wire id passes straight through", () => {
    expect(id("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(id("gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });
  test("unknown names resolve to null so callers can error helpfully", () => {
    expect(resolve("gpt9")).toBeNull();
    expect(resolve("definitely-not-a-model")).toBeNull();
  });
});

describe("registry shape", () => {
  test("both providers are present and newest-first per family", () => {
    const all = models();
    expect(all.some((m) => m.provider === "anthropic")).toBe(true);
    expect(all.some((m) => m.provider === "openai")).toBe(true);
    const opus = all.filter((m) => m.family === "opus");
    expect(opus[0].id).toBe("claude-opus-5");
  });
  test("only the newest of a family owns the bare family alias", () => {
    const five = models().find((m) => m.id === "claude-opus-5")!;
    const old = models().find((m) => m.id === "claude-opus-4-8")!;
    expect(aliasesFor(five)).toContain("opus");
    expect(aliasesFor(old)).not.toContain("opus");
    expect(aliasesFor(old)).toContain("opus48");
  });
});
