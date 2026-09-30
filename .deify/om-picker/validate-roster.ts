#!/usr/bin/env bun
/**
 * Validate `apiplan roster omp` output against OM's REAL models.yml schema.
 *
 * Not a re-implementation of the schema and not a YAML sniff test: it loads the adopted
 * runtime's own `ModelsConfigFile` (arktype schema + `validateProviderConfiguration`) and
 * relocates it onto a temp file, so a schema change in omp fails HERE rather than in the
 * user's picker. The user's live catalog is never read and never written.
 *
 * Usage: bun .deify/om-picker/validate-roster.ts [--runtime <dir>] [--out <receipt.json>]
 * Exit 0 = zero validation errors; 1 = rejected (details on stdout as JSON).
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rosterYaml } from "../../src/roster.ts";

/** The adopted runtime, unless a caller points at another one. */
export const DEFAULT_RUNTIME =
  "/Users/magic/.om/runtimes/closeout-20260906T094900Z/node_modules/@oh-my-pi/pi-coding-agent";

/**
 * The slice of omp's `ModelsConfigFile` this validator uses. Declared here rather than
 * imported as a type because the module lives in a runtime directory chosen at RUN time
 * (`--runtime`, and absent on a machine with no adopted omp) — there is no author-time
 * specifier to `import type` from. Only the fields read below are named, so an omp that
 * adds keys still validates; one that REMOVES any of these fails loudly at the boundary.
 */
type ParsedModel = { id?: unknown; cost?: unknown };
type ParsedProvider = { baseUrl?: unknown; api?: unknown; apiKey?: unknown; models?: unknown };
type ParsedModels = { providers?: Record<string, ParsedProvider> };
type LoadOutcome =
  | { status: "ok"; value: ParsedModels }
  | { status: "error" | "not-found"; value?: null; error?: unknown };
type OmConfigFile = {
  relocate(path: string): { tryLoad(): LoadOutcome };
};
type OmModelsConfigModule = { ModelsConfigFile: OmConfigFile };

export type ValidationResult = {
  ok: boolean;
  /** OM's own error rendering, empty when the file is accepted. */
  errors: string[];
  /** Provider keys OM parsed out of the file — must be exactly ["apiplan"]. */
  providers: string[];
  /** Model ids as OM parsed them, in file order. */
  models: string[];
  /** Per-model cost, as OM parsed it (the picker's price source). */
  cost: Record<string, unknown>;
  /** The provider-level fields OM parsed. */
  provider: { baseUrl?: unknown; api?: unknown; apiKey?: unknown };
};

/** Walk a thrown ConfigError's message + cause/err chain into flat, de-duplicated lines. */
function errorChain(err: unknown): string[] {
  const out: string[] = [];
  let node: unknown = err;
  for (let depth = 0; node && depth < 8; depth++) {
    const rec: Record<string, unknown> =
      typeof node === "object" ? (node as Record<string, unknown>) : {};
    const msg = typeof rec.message === "string" ? rec.message : String(node);
    if (msg && !out.includes(msg)) out.push(msg);
    // ConfigError wraps the real throw under `cause`; its aux-validation form uses `err`.
    node = rec.cause ?? rec.err;
  }
  return out.length ? out : [String(err)];
}

/**
 * Load `text` as a models.yml through OM's ConfigFile. The temp file is what OM reads, so
 * the YAML dialect (Bun's parser), the arktype schema and the aux provider validation all
 * apply exactly as they would on the user's file.
 */
export async function validateModelsYaml(text: string, runtime = DEFAULT_RUNTIME): Promise<ValidationResult> {
  // Runtime-selected specifier — see the note on OmConfigFile above. A static import would
  // hard-fail this whole module (and the test that skips on a missing runtime) on any
  // machine whose omp lives elsewhere.
  const mod = (await import(`${runtime}/src/config/models-config.ts`)) as OmModelsConfigModule;
  const dir = mkdtempSync(join(tmpdir(), "apiplan-om-schema-"));
  const file = join(dir, "models.yml");
  try {
    writeFileSync(file, text);
    // A ConfigFile caches its last load, so relocate() (a fresh instance) is the only way
    // to validate more than one candidate in a process.
    const res = mod.ModelsConfigFile.relocate(file).tryLoad();
    if (res.status !== "ok") {
      return { ok: false, errors: errorChain(res.error ?? `status=${res.status}`), providers: [], models: [], cost: {}, provider: {} };
    }
    const providers = Object.keys(res.value.providers ?? {});
    const p: ParsedProvider = res.value.providers?.apiplan ?? {};
    // OM already accepted the file against its schema, so `models` is a validated array of
    // model rows here — the named type is the invariant, not a shape to re-guard.
    const rows = (Array.isArray(p.models) ? p.models : []) as ParsedModel[];
    return {
      ok: true, errors: [], providers,
      models: rows.map((m) => String(m.id)),
      cost: Object.fromEntries(rows.filter((m) => m.cost !== undefined).map((m) => [String(m.id), m.cost])),
      provider: { baseUrl: p.baseUrl, api: p.api, apiKey: p.apiKey },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The whole file apiplan's block belongs in: the same two lines `--apply` writes around it. */
export const wholeFile = (base?: string) =>
  `# Generated for schema validation by APIPlan .deify/om-picker/validate-roster.ts\nproviders:\n${base ? rosterYaml(base) : rosterYaml()}`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = (f: string) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
  const runtime = at("--runtime") ?? DEFAULT_RUNTIME;
  const text = wholeFile(at("--base"));
  const r = await validateModelsYaml(text, runtime);
  const out = at("--out");
  const payload = { runtime, ...r, modelCount: r.models.length };
  if (out) writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(r.ok ? 0 : 1);
}
