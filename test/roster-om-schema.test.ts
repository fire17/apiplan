/**
 * THE PICKER GATE: does `apiplan roster omp` produce a file OM will actually LOAD?
 *
 * roster.test.ts asserts what this repo MEANT to emit — the order, the labels, the tiers,
 * the key names — by reading the generator's own output. That is necessary and it is not
 * sufficient, for the same reason om-live-proof.test.ts exists: a file can satisfy the
 * spec as its author understood it and still be rejected, or silently thinned, by the real
 * consumer. The failure mode is quiet and expensive — omp logs a config warning and falls
 * back, so the operator's picker shows the OLD roster (or nothing) while every test here
 * stays green, and the new backends are simply unreachable.
 *
 * So this file does not re-implement OM's schema. It loads the ADOPTED RUNTIME'S OWN
 * `ModelsConfigFile` — the arktype schema plus `validateProviderConfiguration`, the exact
 * code path omp runs at boot — over a temp copy of the generated file, and asserts on what
 * OM itself parsed back. Three distinct claims, and the third is the one worth the file:
 *
 *   1. ACCEPTED. Zero validation errors, and exactly ONE provider key, `apiplan`. The
 *      single-provider shape is a decision (see roster.ts's header), so a second key
 *      creeping back in is a regression the picker would show as duplicate models.
 *   2. COMPLETE. Every grok-* and gemini-key-* row survives the crossing. A row the schema
 *      drops is a model the operator cannot pick.
 *   3. PRICED. The cost object comes back INTACT, `longContext` and
 *      `inputThresholdInclusive` included. A schema that accepts the file while discarding
 *      an unrecognised cost key is the WORST case: the picker works, the operator sees the
 *      models, and every long-context turn is mispriced with nothing anywhere complaining.
 *      xAI's boundary is inclusive and bills double from exactly 200,000 tokens, so a
 *      silently-stripped flag under-charges the whole boundary request.
 *
 * SKIPS, NEVER FAILS, when the runtime directory is absent: the absence of a third-party
 * install on some other machine is not a defect in this generator. Same two-gate reasoning
 * as om-live-proof.test.ts, minus the arming flag — this costs nothing and dials nobody, so
 * it runs by default on the machine that has the runtime.
 *
 * Reads nothing of the operator's and writes nothing outside a temp dir: the candidate is
 * generated in-process by `rosterYaml()`, never their live `models.yml`.
 */
import { expect, test, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { validateModelsYaml, wholeFile, DEFAULT_RUNTIME } from "../.deify/om-picker/validate-roster.ts";
import type { ValidationResult } from "../.deify/om-picker/validate-roster.ts";
import { harnessRoster, OM_EFFORTS } from "../src/roster.ts";

/**
 * The module the validator loads. Named here too, so the gate is checked BEFORE the
 * dynamic import inside `validateModelsYaml` would throw — a skipped suite must not
 * depend on catching an import failure.
 */
const OM_MODELS_CONFIG = `${DEFAULT_RUNTIME}/src/config/models-config.ts`;
const gate = describe.skipIf(!existsSync(OM_MODELS_CONFIG));

gate("the generated models.yml, through OM's own loader", () => {
  // ONE load for the whole suite, in beforeAll rather than at describe scope: the parse is
  // the subject, so every assertion should read the SAME parsed result rather than
  // re-deriving it from six loads — and a describe callback cannot await.
  let parsed: ValidationResult;
  beforeAll(async () => { parsed = await validateModelsYaml(wholeFile()); });

  test("OM accepts it with zero validation errors, as exactly one `apiplan` provider", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.providers).toEqual(["apiplan"]);
    // The provider-level fields the single-provider shape depends on. `apiKey` is present
    // and deliberately a placeholder — omp's own validator REQUIRES a key (or `auth: none`)
    // the moment a provider declares models, so dropping it makes the file unloadable.
    expect(parsed.provider.api).toBe("anthropic-messages");
    expect(parsed.provider.apiKey).toBe("not-needed");
    expect(String(parsed.provider.baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("every row the generator emitted comes back, in file order", () => {
    // Compared against the generator rather than a hard-coded list: this test's job is the
    // CROSSING, and a literal here would have to be edited by every lane that adds a model.
    expect(parsed.models).toEqual(harnessRoster().map((e) => e.id));
  });

  test("both new backends' rows reach the picker", () => {
    const grok = parsed.models.filter((id) => id.startsWith("grok-"));
    const geminiKey = parsed.models.filter((id) => id.startsWith("gemini-key-"));
    expect(grok).toContain("grok-4.6");
    expect(geminiKey).toContain("gemini-key-3.8-flash");
    // Not just the two headline ids: the whole families, or a partially-loaded roster
    // would pass while most of the new work stayed invisible.
    expect(grok.length).toBe(harnessRoster().filter((e) => e.id.startsWith("grok-")).length);
    expect(geminiKey.length).toBe(harnessRoster().filter((e) => e.id.startsWith("gemini-key-")).length);
  });

  test("cost survives the crossing intact — every rate, every tier", () => {
    for (const e of harnessRoster()) {
      if (!e.cost) continue;
      // toEqual, not a field-by-field check: an EXTRA or MISSING key is exactly the defect
      // this test exists to catch, and only whole-object equality sees both.
      expect(parsed.cost[e.id]).toEqual(e.cost);
    }
  });

  /**
   * The single most dangerous field, asserted BY NAME on the vendor whose boundary needs
   * it. `toEqual` above already covers it, and it gets its own test anyway: if a future omp
   * renames or drops this key the failure should say WHICH fact was lost, not just that two
   * objects differ somewhere among 43 models.
   */
  test("xAI's inclusive long-context boundary is not silently discarded", () => {
    const grok = parsed.cost["grok-4.6"];
    expect(grok).toMatchObject({ longContext: { inputThreshold: 200_000, inputThresholdInclusive: true } });
  });

  /** Google's Pro tier is EXCLUSIVE, so the flag must be absent — the mirror of the above. */
  test("google's exclusive boundary crosses without acquiring the inclusive flag", () => {
    const pro = parsed.cost["gemini-key-3.1-pro-preview"];
    expect(pro).toMatchObject({ longContext: { inputThreshold: 200_000 } });
    const lc = pro && typeof pro === "object" && "longContext" in pro ? pro.longContext : undefined;
    expect(lc && typeof lc === "object" && "inputThresholdInclusive" in lc).toBe(false);
  });

  test("a second apiplan-ish provider key would be caught, not tolerated", async () => {
    // The negative control for claim 1: proof that `providers: ["apiplan"]` above is an
    // assertion about the file and not an artefact of the reader only ever looking at one
    // key. Same generated block, declared twice under a second name.
    const doubled = `${wholeFile()}  apiplan-canary:\n    baseUrl: http://127.0.0.1:8787\n    api: anthropic-messages\n    apiKey: not-needed\n    models:\n      - id: "grok-4.6"\n`;
    const second = await validateModelsYaml(doubled);
    expect(second.providers).toEqual(["apiplan", "apiplan-canary"]);
  });

  /**
   * 4. THE ZEN ROWS, and the level that used to sink the whole file. OpenCode Zen advertises
   * `none` as a reasoning effort on ten gpt-5.x ids (providers-zen.ts ZEN_FALLBACK, and the
   * same value arrives from the live catalog via catalogEfforts). OM's EffortSchema does not
   * accept it, arktype rejects the WHOLE file on one bad level, and `parsed.providers` comes
   * back [] — every apiplan model gone from the picker, which is the failure the operator
   * actually saw. Asserted here on OM's own parse rather than on the generator's string.
   */
  test("the zen rows cross with an OM-legal ladder and no vendor-only level", () => {
    const zen = parsed.models.filter((id) => id.startsWith("zen-"));
    expect(zen.length).toBe(harnessRoster().filter((e) => e.id.startsWith("zen-")).length);
    expect(zen).toContain("zen-gpt-5.1");
    expect(zen).toContain("zen-muse-spark-1.3");
    expect(wholeFile()).not.toMatch(/efforts: \[[^\]]*\bnone\b/);
  });

  /**
   * 5. ENUM TRIPWIRE. `OM_EFFORTS` is a COPY of a set that lives in someone else's package,
   * so it can drift in two directions and both are silent: OM widening its enum would make
   * this whitelist quietly thin his picker, OM narrowing it would put the file back on the
   * floor. Read the enum out of the runtime's own source and cross it with the constant, so
   * an omp upgrade is a RED here instead of a discovery weeks later. Runtime-path-bound
   * (DEFAULT_RUNTIME) — it needs re-pointing when he adopts a new omp runtime.
   */
  test("OM_EFFORTS is OM's own EffortSchema, read from the runtime's source", () => {
    const src = readFileSync(`${DEFAULT_RUNTIME}/src/config/models-config-schema-bundle.ts`, "utf8");
    const m = src.match(/const EffortSchema = type\('([^']+)'\)/);
    expect(m, "EffortSchema not found — the runtime's schema file moved or was reshaped").not.toBeNull();
    const enumLevels = m![1].split("|").map((x) => x.trim().replace(/^"|"$/g, ""));
    expect([...OM_EFFORTS]).toEqual(enumLevels);
  });
});
