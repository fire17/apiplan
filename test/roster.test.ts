// The harness roster: one `apiplan` provider, in apiplan's default order, labels that
// steer people and agents away from the models fire17 does not want picked.
import { expect, test, describe } from "bun:test";
import { harnessRoster, rosterYaml, applyRoster, HARNESS_ORDER, DUMB_LABEL, JIMMY_ID } from "../src/roster.ts";
import { resolve } from "../src/registry.ts";

describe("harness roster", () => {
  const ids = harnessRoster().map((e) => e.id);
  test("opens in the decided order", () => {
    expect(ids.slice(0, 10)).toEqual([
      "gpt-6-astra", "claude-fable-5-1", "gpt-5.6-sol", "claude-fable-5", "claude-opus-5",
      "claude-opus-4-8", "claude-opus-4-6", "gpt-5.6-terra", "gpt-5.6-luna", JIMMY_ID,
    ]);
    const gem = ids.filter((i) => i.startsWith("gemini-"));
    expect(gem.length).toBeGreaterThanOrEqual(4);
    expect(ids.indexOf(gem[0])).toBe(10);                          // gemini block right after jimmy
    expect(ids.indexOf(`claude-sonnet-5 ${DUMB_LABEL}`)).toBe(10 + gem.length);
    expect(ids[11 + gem.length].startsWith("claude-haiku-") && ids[11 + gem.length].endsWith(DUMB_LABEL)).toBe(true);
  });
  test("sonnet and haiku carry the warning in id AND name, nothing else does", () => {
    for (const e of harnessRoster()) {
      const dumb = /claude-(sonnet|haiku)/.test(e.id);
      expect(e.id.endsWith(DUMB_LABEL)).toBe(dumb);
      expect(e.name.endsWith(DUMB_LABEL)).toBe(dumb);
    }
  });
  test("a labelled id still resolves to the real model", () => {
    expect(resolve(`claude-sonnet-5 ${DUMB_LABEL}`)?.id).toBe("claude-sonnet-5");
    expect(resolve(`claude-haiku-4-5-20251001 ${DUMB_LABEL}`)?.id).toBe("claude-haiku-4-5-20251001");
    expect(resolve("sonnet (anything)")?.id).toBe("claude-sonnet-5");
    expect(resolve("(nothing)")).toBeNull();
  });
  test("no duplicates, no ollama library, jimmy once, every listed id resolves", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.includes(":"))).toEqual([]);           // heretic:latest etc. stay native
    expect(ids.filter((i) => i === JIMMY_ID)).toEqual([JIMMY_ID]);
    for (const id of ids) if (id !== JIMMY_ID) expect(resolve(id)?.id).toBe(id.replace(` ${DUMB_LABEL}`, ""));
  });
  test("astra and the Claude models are reasoning models with their effort ladders; gemini and jimmy are not", () => {
    const by = Object.fromEntries(harnessRoster().map((e) => [e.id, e]));
    expect(by["gpt-6-astra"]).toMatchObject({ reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000 });
    expect(by["claude-opus-5"]).toMatchObject({ reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1000000 });
    expect(by[JIMMY_ID]).toMatchObject({ reasoning: false, input: ["text"] });
    for (const e of harnessRoster()) if (e.id.startsWith("gemini-")) expect(e.reasoning).toBe(false);
  });
  test("windows and list prices are the providers' published ones, not the Codex operating default", () => {
    const by = Object.fromEntries(harnessRoster().map((e) => [e.id, e]));
    // developers.openai.com/api/docs/models/gpt-6-astra (2026-09-05); 916,284 input tokens accepted live, ~962k refused
    expect(by["gpt-6-astra"].cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(by["gpt-5.6-sol"]).toMatchObject({ contextWindow: 1050000, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } });
    expect(by["gpt-5.6-luna"].cost).toEqual({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
    expect(by["gpt-5.4-mini"]).toMatchObject({ contextWindow: 400000, cost: { input: 0.75, output: 4.5 } });
    // platform.claude.com/docs/en/about-claude/pricing: Fable 5.1 cache reads at 0.025x
    expect(by["claude-fable-5-1"].cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(by[`claude-sonnet-5 ${DUMB_LABEL}`].cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(by[`claude-haiku-4-5-20251001 ${DUMB_LABEL}`]).toMatchObject({ contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5 } });
    expect(by[JIMMY_ID].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(rosterYaml()).toContain("cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }");
  });
  test("the yaml is one anthropic-messages provider named apiplan", () => {
    const y = rosterYaml();
    expect(y).toContain("  apiplan:\n    baseUrl: http://127.0.0.1:8787\n    api: anthropic-messages\n");
    expect((y.match(/^      - id:/gm) ?? []).length).toBe(ids.length);
    expect(y).toContain(`- id: "claude-sonnet-5 ${DUMB_LABEL}"`);
    expect(y).toContain("thinking:\n          mode: anthropic-adaptive\n          efforts: [low, medium, high, xhigh, max]");
  });
  test("applying replaces every apiplan* provider and leaves the others untouched", () => {
    const before = `providers:
  apiplan:
    baseUrl: http://127.0.0.1:8787
    api: anthropic-messages
    models:
      - id: claude-opus-5
  # canary comment
  apiplan-cache-canary:
    baseUrl: http://127.0.0.1:8788
    models:
      - id: claude-opus-5
  apiplan-openai:
    baseUrl: http://127.0.0.1:8787/v1
    models:
      - id: gpt-5.6-sol
  ollama:
    baseUrl: http://127.0.0.1:11434
    models:
      - id: heretic:latest
modelRoles:
  default: apiplan/claude-opus-5
`;
    const after = applyRoster(before, "  apiplan:\n    baseUrl: X\n    models:\n      - id: gpt-6-astra\n");
    expect(after).toBe(`providers:
  apiplan:
    baseUrl: X
    models:
      - id: gpt-6-astra
  ollama:
    baseUrl: http://127.0.0.1:11434
    models:
      - id: heretic:latest
modelRoles:
  default: apiplan/claude-opus-5
`);
    // no providers section at all → one is appended
    expect(applyRoster("modelRoles:\n  default: x\n", "  apiplan:\n    baseUrl: X\n")).toBe("modelRoles:\n  default: x\nproviders:\n  apiplan:\n    baseUrl: X\n");
  });
  test("applyRoster keeps unrelated providers when the providers key carries a comment", async () => {
    const { applyRoster } = await import("../src/roster");
    const before = "providers: # custom providers\n  ollama:\n    baseUrl: http://x\n  apiplan-old:\n    baseUrl: http://y\n";
    const after = applyRoster(before);
    expect(after.match(/^providers:/gm)).toHaveLength(1);
    expect(after).toContain("  ollama:");
    expect(after).not.toContain("apiplan-old:");
  });
});
