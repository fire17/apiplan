// The harness roster: one `apiplan` provider, in apiplan's default order, labels that
// steer people and agents away from the models fire17 does not want picked.
import { expect, test, describe } from "bun:test";
import { harnessRoster, rosterYaml, applyRoster, HARNESS_ORDER, DUMB_LABEL, JIMMY_ID, DOCUMENTED, entryFor, harnessEfforts, OM_EFFORTS } from "../src/roster.ts";
import { resolve, ANTHROPIC_EFFORTS } from "../src/registry.ts";
import type { Model } from "../src/registry.ts";
// The zen parity test reads opencode's own catalog file — the one external input in this
// suite, and it is read-only and never written.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

describe("harness roster", () => {
  const ids = harnessRoster().map((e) => e.id);
  test("opens in the decided order", () => {
    // Machine-independent (2026-09-29): which ordered ids exist depends on this machine's
    // ~/.apiplan catalog cache (gpt-6-sol/luna appear only after a refresh at client_version
    // >= 0.155.0), so the assertion is "the ids that ARE present open the roster, in
    // HARNESS_ORDER's order" rather than a fixed slice.
    const present = HARNESS_ORDER.filter((x) => !x.endsWith("*") && ids.includes(x));
    expect(present.length).toBeGreaterThanOrEqual(8);
    expect(ids.slice(0, present.length)).toEqual(present);
    expect(ids.indexOf("claude-opus-5-5")).toBe(ids.indexOf("claude-opus-5") - 1); // Opus 5.5 leads the Opus block
    const head = present.length;
    const gem = ids.filter((i) => i.startsWith("gemini-"));
    expect(gem.length).toBeGreaterThanOrEqual(4);
    expect(ids.indexOf(gem[0])).toBe(head);                        // gemini block right after jimmy
    expect(ids.indexOf(`claude-sonnet-5-5 ${DUMB_LABEL}`)).toBe(head + gem.length);
    expect(ids.indexOf(`claude-sonnet-5 ${DUMB_LABEL}`)).toBe(head + 1 + gem.length);
    expect(ids[head + 2 + gem.length].startsWith("claude-haiku-") && ids[head + 2 + gem.length].endsWith(DUMB_LABEL)).toBe(true);
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
    expect(resolve(`claude-sonnet-5-5 ${DUMB_LABEL}`)?.id).toBe("claude-sonnet-5-5");
    expect(resolve("sonnet (anything)")?.id).toBe("claude-sonnet-5-5");
    expect(resolve("(nothing)")).toBeNull();
  });
  test("no duplicates, no ollama library, jimmy once, every listed id resolves", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.includes(":"))).toEqual([]);           // heretic:latest etc. stay native
    expect(ids.filter((i) => i === JIMMY_ID)).toEqual([JIMMY_ID]);
    for (const id of ids) if (id !== JIMMY_ID) expect(resolve(id)?.id).toBe(id.replace(` ${DUMB_LABEL}`, ""));
  });
  test("astra and the Claude models are reasoning models with their effort ladders; jimmy is not", () => {
    const by = Object.fromEntries(harnessRoster().map((e) => [e.id, e]));
    expect(by["gpt-6-astra"]).toMatchObject({ reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000 });
    expect(by["claude-opus-5"]).toMatchObject({ reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1000000 });
    expect(by["claude-opus-5-5"]).toMatchObject({ reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1000000, maxTokens: 128000 });
    expect(by[JIMMY_ID]).toMatchObject({ reasoning: false, input: ["text"] });
  });
  /**
   * THE TWO GOOGLE ROUTES DISAGREE ABOUT REASONING, and the disagreement is the point.
   * `gemini-3.8-flash` and `gemini-key-3.8-flash` are the SAME underlying vendor model
   * reached two ways, and only one of them exposes thinking to a caller — so a blanket
   * "every gemini is non-reasoning" (which this file asserted while the subscription was
   * the only route) is now false, and a blanket true would be false the other way.
   *
   * Both halves are asserted, because a one-sided narrowing would leave the capability with
   * NO coverage: a later edit could flatten the key rows to reasoning:false and nothing
   * would fail.
   */
  test("reasoning is per-ROUTE for gemini: the subscription has none, the API key does", () => {
    const rows = harnessRoster().filter((e) => e.id.startsWith("gemini-"));
    // Both routes are actually present, or the assertions below are vacuous.
    const subscription = rows.filter((e) => /^gemini-\d/.test(e.id));
    const apiKey = rows.filter((e) => e.id.startsWith("gemini-key-"));
    expect(subscription.length).toBeGreaterThanOrEqual(4);
    expect(apiKey.length).toBeGreaterThanOrEqual(10);

    // SUBSCRIPTION (`google`): the effort rides the WIRE ID (gemini-3.6-flash-low) and the
    // Antigravity adapter has been observed to 400 on an effort it does not serve, so there
    // is no request field for a harness to set. omp is told not to send one.
    for (const e of subscription) {
      expect(e.reasoning).toBe(false);
      expect(e.efforts).toBeUndefined();
    }

    // API KEY (`gemini`): thinking is a real REQUEST FIELD, measured live 2026-09-06 —
    // `thinkingConfig.thinkingLevel:"LOW"` on gemini-3.8-flash returned 200 with
    // usageMetadata.thoughtsTokenCount 29, and `thinkingConfig.thinkingBudget:512` on
    // gemini-2.5-flash returned 200 with thoughtsTokenCount 25. Setting an effort here
    // changes what the model does AND what it costs (thinking tokens bill as output), so
    // the picker must show the capability.
    //
    // The LIVE ids are the exception and stay false: bidiGenerateContent is a different
    // protocol with no thinking parameter, so they carry no efforts at all.
    const live = (id: string) => /-live|-native-audio|-transcribe/.test(id);
    for (const e of apiKey) {
      if (live(e.id)) { expect(e.reasoning).toBe(false); continue; }
      expect(e.reasoning).toBe(true);
      // Every ladder is one of the two the vendor documents, and `minimal` appears only on
      // the ids whose docs list it — sending a level a model does not serve is a 400.
      expect([["low", "medium", "high"], ["minimal", "low", "medium", "high"]]).toContainEqual(e.efforts);
      expect(e.defaultLevel).toBe("medium");
    }
    // At least one of each ladder is present, so neither branch is vacuous.
    expect(apiKey.some((e) => e.efforts?.[0] === "minimal")).toBe(true);
    expect(apiKey.some((e) => e.efforts?.[0] === "low")).toBe(true);
  });
  test("windows and list prices are the providers' published ones, not the Codex operating default", () => {
    const by = Object.fromEntries(harnessRoster().map((e) => [e.id, e]));
    // The SHORT-context card is unchanged by the long-context work; `longContext` is asserted
    // separately below, so these stay `toMatchObject` on the base rates rather than `toEqual`.
    // developers.openai.com/api/docs/models/gpt-6-astra (2026-09-05); 916,284 input tokens accepted live, ~962k refused
    expect(by["gpt-6-astra"].cost).toMatchObject({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(by["gpt-5.6-sol"]).toMatchObject({ contextWindow: 1050000, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } });
    expect(by["gpt-5.6-luna"].cost).toMatchObject({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
    expect(by["gpt-5.4-mini"]).toMatchObject({ contextWindow: 400000, cost: { input: 0.75, output: 4.5 } });
    // platform.claude.com/docs/en/about-claude/pricing: Fable 5.1 cache reads at 0.025x
    expect(by["claude-fable-5-1"].cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(by[`claude-sonnet-5 ${DUMB_LABEL}`].cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    // 2026-09-30 pricing page: Opus 5.5 $4/$20, cache hits 0.05x; Sonnet 5.5 $2/$10
    expect(by["claude-opus-5-5"].cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(by[`claude-sonnet-5-5 ${DUMB_LABEL}`].cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(by[`claude-haiku-4-5-20251001 ${DUMB_LABEL}`]).toMatchObject({ contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5 } });
    expect(by[JIMMY_ID].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(rosterYaml()).toContain("cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,");
  });

  // ── long-context tiers ────────────────────────────────────────────────────────────────────
  // OpenAI bills a prompt over 272K input tokens at a premium for the FULL request. Emitting
  // only the short-context card made the estimate silently ~2x LOW on exactly the long sessions
  // where it matters. These pin the published rates, and pin that nothing else grew a tier.
  describe("long-context tiers", () => {
    const by = Object.fromEntries(harnessRoster().map((e) => [e.id, e]));
    test("every tier is the model page's own published long-context card", () => {
      // developers.openai.com/api/docs/pricing long-context columns, read 2026-09-06.
      // Astra's model page is explicit that CACHE rates double too, not just input.
      expect(by["gpt-6-astra"].cost?.longContext).toEqual({ inputThreshold: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 });
      expect(by["gpt-5.6-sol"].cost?.longContext).toEqual({ inputThreshold: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 });
      expect(by["gpt-5.6-terra"].cost?.longContext).toEqual({ inputThreshold: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 });
      expect(by["gpt-5.6-luna"].cost?.longContext).toEqual({ inputThreshold: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 });
      // 5.5's table prints no long-context cache-write, so the base scalar carries rather than
      // a multiplier being invented for it.
      expect(by["gpt-5.5"].cost?.longContext).toEqual({ inputThreshold: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 6.25 });
      // Long-context input is 2x the short card and output 1.5x — a cheap guard on a
      // transcription slip. Compared with a tolerance: the published rates are decimal figures
      // (Luna's 1.2 -> 1.8), and binary floating point does not reproduce them exactly.
      for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]) {
        expect(by[id].cost?.longContext?.input).toBeCloseTo(by[id].cost!.input * 2, 10);
        expect(by[id].cost?.longContext?.output).toBeCloseTo(by[id].cost!.output * 1.5, 10);
      }
    });
    test("each tier keeps its OWN vendor's boundary and inclusivity, and nothing untiered grows one", () => {
      // gpt-5.4-mini states none AND caps input at exactly 272,000 — it can never exceed it.
      expect(by["gpt-5.4-mini"].cost?.longContext).toBeUndefined();
      // SEVERAL vendors publish a tier now, at DIFFERENT boundaries with DIFFERENT
      // semantics, and the two facts are independent — which is exactly why they are
      // asserted per row rather than globally:
      //   · OpenAI's pages say ">272K", i.e. STRICT, so those rows must leave
      //     `inputThresholdInclusive` absent and inherit the harness's strict default;
      //   · xAI's say "requests whose prompt REACHES 200k are billed at the higher rate for
      //     all tokens", i.e. INCLUSIVE, so the grok rows set the flag at a true 200,000.
      // Getting either wrong is a silent one-token mispricing at the boundary, in opposite
      // directions: an inherited `true` on an OpenAI row moves Astra's boundary early, and a
      // missing one on a grok row under-charges every request that lands exactly on 200,000.
      // A vendor whose docs this repo has not read states no flag, which is the honest
      // default rather than a claim either way.
      // Static, string-keyed, literal: a Record, not a Set. The four ids whose vendor pages
      // state an INCLUSIVE boundary; every other tiered row must leave the flag absent.
      const INCLUSIVE_TIER: Record<string, true> = { "grok-4.6": true, "grok-4.5": true, "grok-4.3": true, "grok-build-0.1": true };
      let tiers = 0;
      for (const e of harnessRoster()) {
        const lc = e.cost?.longContext;
        // No provider may grow a tier out of nowhere: a tier is a PUBLISHED rate card, so a
        // row that has one must be a row this repo read a page for.
        if (!lc) { expect(INCLUSIVE_TIER[e.id]).toBeUndefined(); continue; }
        tiers++;
        // Anthropic and the local llama publish no equivalent tier at all.
        expect(/^(claude|llama)/.test(e.id)).toBe(false);
        // Every threshold is one of the two documented boundaries — never an emulated
        // off-by-one like 199,999, which would price the boundary turn right while making
        // the field itself false.
        expect([200_000, 272_000]).toContain(lc.inputThreshold);
        expect(lc.inputThresholdInclusive).toBe(INCLUSIVE_TIER[e.id] ? true : undefined);
        if (e.id.startsWith("gpt-")) expect(lc.inputThreshold).toBe(272_000);
        if (e.id.startsWith("grok")) expect(lc.inputThreshold).toBe(200_000);
        // Whatever carries a tier carries a WHOLE rate card. cacheWrite is the one rate that
        // may legitimately be ZERO rather than positive: xAI reports no cache-write counter
        // at all and publishes no write price, so a positive number there would be invented.
        for (const k of ["input", "output", "cacheRead"] as const) {
          expect(typeof lc[k]).toBe("number");
          expect(lc[k]).toBeGreaterThan(0);
        }
        expect(typeof lc.cacheWrite).toBe("number");
        expect(lc.cacheWrite).toBeGreaterThanOrEqual(0);
      }
      // Every id in the inclusive table really is in the roster and really did carry a tier.
      expect(tiers).toBeGreaterThanOrEqual(Object.keys(INCLUSIVE_TIER).length);
    });
    test("the yaml nests the tier inside the cost map, and only where documented", () => {
      const y = rosterYaml();
      expect(y).toContain(
        "cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, longContext: { inputThreshold: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 } }",
      );
      // The count tracks the catalog, so it is derived from the roster rather than frozen:
      // a hard number here fails every time any vendor documents another tier, which says
      // nothing about the EMITTER. What the emitter must get right is that every tier in the
      // data reaches the YAML, and that the inclusive flag appears on exactly those rows
      // that carry it — no more, no fewer.
      const rows = harnessRoster().filter((e) => e.cost?.longContext);
      const inclusiveRows = rows.filter((e) => e.cost!.longContext!.inputThresholdInclusive);
      expect(rows.length).toBeGreaterThan(inclusiveRows.length);   // both kinds are present
      expect((y.match(/longContext:/g) ?? []).length).toBe(rows.length);
      expect((y.match(/inputThresholdInclusive: true/g) ?? []).length).toBe(inclusiveRows.length);
      // The flag is emitted BY NAME. That name is pi-catalog's, so a rename upstream must
      // break loudly here rather than silently dropping the flag — a dropped flag reverts
      // the tier to a strict comparator and under-charges every boundary request.
      for (const e of inclusiveRows) {
        expect(y).toContain(`inputThreshold: ${e.cost!.longContext!.inputThreshold}, inputThresholdInclusive: true`);
      }
      expect(y).toContain("cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.9375 }\n");
      // Every emitted cost line must be a WELL-FORMED flow map: braces balanced, and the nested
      // tier closed before the outer one. Checked by scanning, since apiplan has no yaml
      // dependency and must not grow one just to test its own generator.
      const costLines = y.split("\n").filter((l) => l.trimStart().startsWith("cost: {"));
      expect(costLines.length).toBeGreaterThan(0);
      for (const line of costLines) {
        const body = line.slice(line.indexOf("{"));
        let depth = 0;
        for (const ch of body) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
        expect(body.endsWith("}")).toBe(true);
        // No key may be emitted empty or undefined into the generated file.
        expect(body).not.toContain("undefined");
        expect(body).not.toMatch(/:\s*[,}]/);
      }
    });
    test("the documented tier rule prices the boundary strictly and counts cache toward it", () => {
      // The tier is only worth emitting if a consumer applying the DOCUMENTED rule gets the
      // published answer. The rule is stated on the model pages and implemented by the harness
      // (pi-catalog `resolveTokenCost`): the whole request re-prices once the prompt — uncached
      // input PLUS cache reads and writes — is strictly greater than `inputThreshold`.
      // Re-stated here rather than imported: apiplan takes no harness dependency, by design.
      const card = by["gpt-6-astra"].cost!;
      const price = (input: number, cacheRead: number, output: number) => {
        const prompt = input + cacheRead;
        const r = prompt > card.longContext!.inputThreshold ? card.longContext! : card;
        return (r.input * input + r.cacheRead * cacheRead + r.output * output) / 1_000_000;
      };
      // Strictly ABOVE: 272,000 exactly is still the short card, matching OpenAI's ">272K".
      expect(price(272_000, 0, 0)).toBeCloseTo(2.72, 6);
      expect(price(272_001, 0, 0)).toBeCloseTo(5.44002, 6);
      // Cache reads count toward the prompt total that selects the tier.
      expect(price(271_000, 1_000, 0)).toBeCloseTo(2.711, 6);
      // 271,000 uncached at $20/M + 1,001 cache reads at $2/M.
      expect(price(271_000, 1_001, 0)).toBeCloseTo(5.422002, 6);
      // The real observed turn (input 589,146 / cacheRead 10,368 / output 238). The short-only
      // card estimated ~$5.95; the documented tier is what actually applies — so the previous
      // estimate was LOW, which is why "estimate" must never be read as an upper bound.
      // Cross-checked against the harness's own `calculateUsageCost` (2026-09-06): identical.
      expect(price(589_146, 10_368, 238)).toBeCloseTo(11.821506, 6);
      expect(price(589_146, 10_368, 238)).toBeGreaterThan(price(272_000, 0, 0));
    });
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


  /**
   * ── OPENCODE ZEN ──────────────────────────────────────────────────────────────────────
   *
   * Two halves, deliberately separated, because they fail for different reasons and a reader
   * of the output must be able to tell WHICH:
   *   · the DOCUMENTED table — this file's own data, checkable with no other patch applied;
   *   · the ROSTER rows — which need the `zen` provider in the registry (WI1). Until that
   *     lands, the second block is RED and says so by name. That is honest dependency
   *     reporting, not a broken test: a green suite here while no zen model is addressable
   *     would be the vacuity this repo keeps catching.
   */
  describe("zen: the documented rate card", () => {
    // R1 — the literal muse row, hand-transcribed from the catalog print-out rather than
    // generated, so a generator bug and this assertion cannot agree with each other.
    test("zen-muse-spark-1.3 carries the vendor's own numbers", () => {
      expect(DOCUMENTED["zen-muse-spark-1.3"]).toEqual({
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
      });
      // cacheWrite 0 is an ABSENCE (the catalog prints no `cache_write` for this id), and no
      // long-context tier exists for it — asserted, because a silently grown tier would
      // re-price every long muse turn.
      expect(DOCUMENTED["zen-muse-spark-1.3"].cost.longContext).toBeUndefined();
    });

    // R2 — DRIFT DETECTOR, and only that. The table was transcribed FROM this file, so this
    // proves nothing about opencode's prices today; what it does is turn a future rewrite of
    // the catalog (opencode rewrites it on launch) into a red test instead of a stale
    // estimate nobody notices. Stated plainly so the pass is not read as corroboration.
    test("every zen row still equals opencode's catalog (drift is a finding)", () => {
      const path = process.env.APIPLAN_ZEN_MODELS ?? `${homedir()}/.cache/opencode/models.json`;
      if (!existsSync(path)) {
        console.log(`[zen] catalog absent at ${path} — parity NOT checked this run (opencode not installed?)`);
        return;
      }
      const cat = JSON.parse(readFileSync(path, "utf8"))?.opencode?.models ?? {};
      const rows = Object.entries(DOCUMENTED).filter(([id]) => id.startsWith("zen-"));
      // Non-vacuous over an empty set: the table must actually carry rows to compare.
      expect(rows.length).toBeGreaterThanOrEqual(26);
      for (const [id, doc] of rows) {
        const m = cat[id.slice(4)];
        expect(m, `${id} is not in the catalog any more`).toBeDefined();
        expect(m.limit.context, `${id} contextWindow`).toBe(doc.contextWindow);
        expect(m.limit.output, `${id} maxTokens`).toBe(doc.maxTokens);
        expect(m.cost.input, `${id} input`).toBe(doc.cost.input);
        expect(m.cost.output, `${id} output`).toBe(doc.cost.output);
        expect(m.cost.cache_read ?? 0, `${id} cacheRead`).toBe(doc.cost.cacheRead);
        expect(m.cost.cache_write ?? 0, `${id} cacheWrite`).toBe(doc.cost.cacheWrite);
        // Only the PAID, Responses-dialect ids may be listed: a free id would show a $0
        // estimate for a route that refuses to serve it outside opencode, and a
        // chat/anthropic/google-dialect id is not addressable by this provider at all.
        expect(m.cost.input, `${id} must be a PAID id`).toBeGreaterThan(0);
        expect(m.provider?.npm, `${id} must be the Responses dialect`).toBe("@ai-sdk/openai");
        // A tier here must be the catalog's own tier, at its own size, and STRICT — see the
        // `zenTier` comment: opencode's biller compares `F > tier.size`.
        const t = (m.cost.tiers ?? []).filter((x: any) => x?.tier?.type === "context")[0];
        if (!t) { expect(doc.cost.longContext, `${id} grew a tier the catalog does not print`).toBeUndefined(); continue; }
        expect(doc.cost.longContext, `${id} dropped the catalog's context tier`).toBeDefined();
        expect(doc.cost.longContext!.inputThreshold).toBe(t.tier.size);
        expect(doc.cost.longContext!.input).toBe(t.input);
        expect(doc.cost.longContext!.output).toBe(t.output);
        expect(doc.cost.longContext!.cacheRead).toBe(t.cache_read ?? 0);
        expect(doc.cost.longContext!.cacheWrite).toBe(t.cache_write ?? 0);
        expect(doc.cost.longContext!.inputThresholdInclusive).toBeUndefined();
      }
    });

    /**
     * R3 — the priced turn, on the one REAL zen conversation in evidence on this machine:
     * ~/.local/share/opencode/opencode.db, assistant row 2026-09-09 11:32:54, providerID
     * `opencode`, model `muse-spark-1.3-contributor-free`, tokens
     * {total 134660, input 889, output 3307, reasoning 1583, cache {read 128881, write 0}}.
     *
     * TWO CORRECTIONS TO THE NUMBER THIS LANE WAS BRIEFED WITH, both from opencode's own
     * token writer (~/.opencode/bin/opencode v1.18.30, byte offset 67539101), opened:
     *
     *     Y = inputTokens; W = outputTokens; H = reasoningTokens; Z = cacheReadInputTokens
     *     V = Y - Z - J;  z = { total, input: V, output: K(W - H), reasoning: H, cache:{read:Z} }
     *
     *   (1) `input` in the DB is ALREADY net of cache — so the wire's `input_tokens` was
     *       889 + 128,881 = 129,770. That is the INCLUSIVE basis, confirmed by arithmetic
     *       rather than by a sentence, and it is what the brief said.
     *   (2) `output` in the DB is ALREADY net of REASONING — `output: K(W - H)`. So the
     *       wire's `output_tokens` was 3,307 + 1,583 = 4,890, and 4,890 is what a
     *       Responses-dialect route bills as output. The brief priced 3,307 and called the
     *       result $0.034498; pricing the visible half of the output under-states this turn
     *       by 19.5%. Corroborated by the same row's own `total`, which is passed straight
     *       through from the vendor: 129,770 + 4,890 = 134,660, exactly the stored total.
     *   (3) And the briefed figure is arithmetically wrong even for its own reading:
     *       889*1.25 + 3307*4.25 + 128881*0.15 = 34,498.15 / 1e6 = $0.03449815, which is
     *       1.5e-7 away from "0.034498 +/- 1e-9" — a tolerance no implementation could meet.
     *
     * NOT SETTLED, and it belongs to whoever gets a key: the same `total` relation does NOT
     * hold on the 11:13:22 row of that conversation (131,289 + 924 = 132,213 vs a stored
     * total of 131,796, which matches only if reasoning is INSIDE output there). One row
     * says reasoning is additive, another says it is contained. Both are the VENDOR's own
     * totalTokens field, so `total` is not a reliable cross-check across rows — the
     * subtraction in the writer is. A keyed live turn (A7) settles it; until then this test
     * prices the reading the CODE supports and names the other out loud.
     */
    test("the documented rule prices the real muse turn, with reasoning inside output", () => {
      const card = DOCUMENTED["zen-muse-spark-1.3"].cost;
      // Same shape as the astra tier test above: the harness's documented rule, re-stated
      // rather than imported, because apiplan takes no harness dependency.
      const price = (input: number, cacheRead: number, output: number) => {
        const prompt = input + cacheRead;
        const r = card.longContext && prompt > card.longContext.inputThreshold ? card.longContext : card;
        return (r.input * input + r.cacheRead * cacheRead + r.output * output) / 1_000_000;
      };
      const WIRE_OUTPUT = 3307 + 1583;                         // outputTokens = stored output + reasoning
      expect(WIRE_OUTPUT).toBe(4890);
      // 889*1.25 + 4890*4.25 + 128881*0.15 = 1111.25 + 20782.5 + 19332.15 = 41225.9 / 1e6
      expect(price(889, 128_881, WIRE_OUTPUT)).toBeCloseTo(0.0412259, 9);
      // THE TRAP, asserted so it cannot quietly come back: pricing the DB's already-net
      // output is the briefed $0.03449815, and it is 19.5% low on this turn.
      expect(price(889, 128_881, 3307)).toBeCloseTo(0.03449815, 9);
      expect(price(889, 128_881, 3307)).toBeLessThan(price(889, 128_881, WIRE_OUTPUT));
      // muse publishes no tier, so the 129,770-token prompt does NOT re-price — the one
      // place a borrowed OpenAI 272k tier would have changed this answer.
      expect(card.longContext).toBeUndefined();
    });
  });

  describe("zen rows in the roster (requires WI1's registry patch)", () => {
    const zenRows = harnessRoster().filter((e) => e.id.startsWith("zen-"));
    // The gate for everything below. RED until `zen` is a ProviderId with models — which is
    // exactly what this WI depends on, said by name instead of skipped into silence.
    test("zen models reach the roster at all", () => {
      expect(zenRows.length, "no zen rows — apply patches/fof/OPENCODE-ZEN-PORT-WI1.patch").toBeGreaterThan(0);
    });
    // R1b — the same muse numbers, this time through the roster's own entryFor().
    test("the muse row carries its name, ladder, window and card", () => {
      const muse = zenRows.find((e) => e.id === "zen-muse-spark-1.3");
      expect(muse).toBeDefined();
      expect(muse).toMatchObject({
        name: "Muse Spark 1.3",
        reasoning: true,
        efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "medium",
        contextWindow: 1_048_576,
        maxTokens: 131_072,
        cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
      });
      // The gateway speaks the Responses dialect to zen, which HAS a `developer` role — but
      // `honoursMidConversationInstruction` returns true only for provider "openai", so this
      // key is absent today. Asserted as ABSENT rather than wished true: it is providers.ts's
      // call (WI1's file), and a wrong `true` makes a harness send a role that is dropped.
      // FINDING for the reviewer, not a silent fix here.
      expect(muse!.compat).toBeUndefined();
    });
    // R4 — his picker order is untouched, and zen never gets in front of it.
    test("HARNESS_ORDER is byte-identical and every zen id lands after every other row", () => {
      expect(HARNESS_ORDER).toEqual([
        "gpt-6-astra", "claude-fable-5-1", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "claude-fable-5", "claude-opus-5-5",
        "claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna", JIMMY_ID,
        "gemini-*", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-*",
      ]);
      const all = harnessRoster().map((e) => e.id);
      const firstZen = all.findIndex((i) => i.startsWith("zen-"));
      expect(firstZen).toBeGreaterThan(-1);
      expect(all.slice(firstZen).every((i) => i.startsWith("zen-"))).toBe(true);
    });
    // R5 — a zen id must never shadow, or be shadowed by, the vendor id it republishes.
    test("no zen id collides with a non-zen id, and the table is fully listed", () => {
      const all = harnessRoster().map((e) => e.id);
      expect(new Set(all).size).toBe(all.length);
      for (const e of zenRows) expect(all.filter((i) => i === e.id)).toHaveLength(1);
      // Everything the roster lists as zen must be a row this file priced — an unpriced zen
      // id would show a harness NO cost at all, which reads as free.
      for (const e of zenRows) expect(DOCUMENTED[e.id], `${e.id} has no documented card`).toBeDefined();
    });
  });

  // The OM boundary. OM's models.yml schema (pi-coding-agent
  // src/config/models-config-schema-bundle.ts:88 `EffortSchema`, :104 `"efforts?"`) accepts
  // exactly six levels; arktype rejects the WHOLE file on a seventh, so ONE vendor level
  // emptied `parsed.providers` and every apiplan model vanished from his picker. OpenCode
  // Zen advertises "none" on ten gpt-5.x ids and it is a REAL effort apiplan sends on its own
  // wire (providers-zen.ts:447, bin/apiplan.ts:70 RESPONSES_EFFORTS) — so the narrowing lives
  // here, at the harness boundary, and never in the catalog. One fixture per verdict
  // (filtered / emptied) plus a clean case that must not move.
  describe("OM effort boundary: a vendor level OM's schema does not accept never reaches the harness", () => {
    // T1 FILTERED — zen-gpt-5.1's real ladder (providers-zen.ts:167).
    test('a vendor ladder carrying "none" reaches the harness without it, in catalog order', () => {
      expect(harnessEfforts({ provider: "zen", efforts: ["none", "low", "medium", "high"] }))
        .toEqual(["low", "medium", "high"]);
    });
    // T2 EMPTIED — an id whose ONLY advertised level is outside OM's set shows no thinking
    // control at all, rather than an empty `efforts: []` OM would also reject.
    test('an id advertising only "none" yields reasoning:false and no thinking keys', () => {
      const only: Model = { id: "zen-gpt-only-none", provider: "zen", family: "zengpt", version: [], label: "fixture", efforts: ["none"] };
      const e = entryFor(only);
      expect(e).toMatchObject({ reasoning: false });
      expect(e.efforts).toBeUndefined();
      expect(e.defaultLevel).toBeUndefined();
    });
    // T3 CLEAN — the filter is a no-op on every ladder already inside OM's set, including
    // anthropic's documented default ladder (registry.ts ANTHROPIC_EFFORTS).
    test("a ladder already inside OM's set is untouched, anthropic's default included", () => {
      expect(harnessEfforts({ provider: "zen", efforts: ["low", "medium", "high", "xhigh"] }))
        .toEqual(["low", "medium", "high", "xhigh"]);
      expect(harnessEfforts({ provider: "anthropic" })).toEqual(ANTHROPIC_EFFORTS);
    });
    // T4 REAL ROWS — the same rule read off the live roster, not a fixture.
    test("the real zen rows and the emitted yaml carry no level OM would reject", () => {
      const rows = harnessRoster();
      const by = (id: string) => rows.find((e) => e.id === id);
      expect(by("zen-gpt-5.1")?.efforts).toEqual(["low", "medium", "high"]);
      expect(by("zen-gpt-5.6-luna")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" });
      // Unchanged by the filter: its whole ladder was already OM-legal.
      expect(by("zen-muse-spark-1.3")?.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
      expect(rosterYaml()).not.toMatch(/efforts: \[[^\]]*\bnone\b/);
      for (const e of rows) for (const level of e.efforts ?? [])
        expect(OM_EFFORTS as readonly string[], `${e.id} emits ${level}`).toContain(level);
    });
    // T5 SET PIN — the six, in OM's own order (models-config-schema-bundle.ts:88). The
    // roster-om-schema suite reads that line out of the runtime and crosses it with this
    // constant; this leg pins the constant itself so a hand edit here is a RED.
    test("OM_EFFORTS is exactly OM's six, in order", () => {
      expect(OM_EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    });
  });
});

// 2026-09-29 (P2): GPT-6 Sol/Luna rows, from synthetic models so no catalog cache is needed.
describe("GPT-6 Sol/Luna rows", () => {
  const eff = ["low", "medium", "high", "xhigh", "max"];
  const mk = (id: string, variant: string): Model => ({ id, provider: "openai", family: "gpt", version: [6], variant, label: id, efforts: eff } as any);
  test("sol and luna carry the published window, output cap and prices", () => {
    const sol = entryFor(mk("gpt-6-sol", "sol")), luna = entryFor(mk("gpt-6-luna", "luna"));
    for (const e of [sol, luna]) {
      expect(e.contextWindow).toBe(1_050_000);
      expect(e.maxTokens).toBe(128_000);
    }
    expect(sol.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5,
      longContext: { inputThreshold: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 } });
    expect(luna.cost).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      longContext: { inputThreshold: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 } });
  });
  test("gpt-6.1-sol carries its published window and prices — cached input at 5%, not oai()'s 10%", () => {
    // developers.openai.com/api/docs/models/gpt-6.1-sol, read 2026-10-01.
    const e = entryFor(mk("gpt-6.1-sol", "sol"));
    expect(e.contextWindow).toBe(1_050_000);
    expect(e.maxTokens).toBe(128_000);
    expect(e.cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      longContext: { inputThreshold: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } });
  });
  test("each sits at the head of its family slot, the 5.6 id right behind it", () => {
    expect(HARNESS_ORDER.indexOf("gpt-6-sol") + 1).toBe(HARNESS_ORDER.indexOf("gpt-5.6-sol"));
    expect(HARNESS_ORDER.indexOf("gpt-6-luna") + 1).toBe(HARNESS_ORDER.indexOf("gpt-5.6-luna"));
    // 2026-09-30: GPT-6.1-Sol heads the Sol slot, GPT-6-Sol right behind it.
    expect(HARNESS_ORDER.indexOf("gpt-6.1-sol")).toBe(2);
    expect(HARNESS_ORDER.indexOf("gpt-6-sol")).toBe(3);
  });
});
