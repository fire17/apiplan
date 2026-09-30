// gemini-wire.ts — the GEMINI proto shape, read and written in ONE place.
//
// WHY THIS IS ITS OWN MODULE. Two backends here speak this shape, and neither is the
// other's parent:
//   · google — the Antigravity / Gemini Code Assist SUBSCRIPTION, an OAuth token and a
//              `v1internal:streamGenerateContent` endpoint whose body wraps the request in
//              `{ model, project, request }`, in providers.ts;
//   · gemini — the same vendor reached by API KEY, the documented public
//              `v1beta/models/{model}:streamGenerateContent`, in providers-gemini.ts.
// The credential, the URL, the body envelope and the catalog all differ. What does NOT
// differ is the proto: the same `Content`/`Part` shapes, the same `Schema` subset, the same
// `thoughtSignature` requirement, the same `usageMetadata` field names. Those are facts
// about the VENDOR, not about either route.
//
// These readers lived in providers.ts, where the `google` adapter was written. Importing
// them from providers-gemini.ts made a CYCLE — providers.ts imports the gemini provider to
// put it in PROVIDERS, and providers-gemini.ts imported providers.ts for the helpers — and
// that cycle is not a style problem, it is a real temporal-dead-zone crash. Bun/ESM
// evaluated providers-gemini.ts first, which re-entered a providers.ts that had not yet
// initialised its own bindings, and `PROVIDERS = { …, gemini }` threw `ReferenceError:
// Cannot access '…' before initialization` at import time — measured, exactly the failure
// responses-wire.ts was extracted to end for the grok adapter.
//
// So the fix is the same and it is directional rather than defensive: this module is a
// LEAF. It imports nothing at runtime — only `type` declarations, which ESM erases
// entirely — so both adapters can depend on it and neither depends on the other. Copying
// the readers into the second adapter would have broken the cycle too, and would have been
// the wrong repair: a second copy of a vendor rule drifts silently the day the proto gains
// or loses a key, and nothing fails until a 400 in production.
import type { Turn } from "./providers.ts";

/**
 * Gemini's endpoint is strict proto-JSON: an unknown field is a 400, and its `Schema` is a
 * SUBSET of JSON Schema. Claude Code's tool schemas carry $schema, additionalProperties,
 * const and exclusiveMinimum, none of which exist in that proto — so the schema is pruned
 * to the fields the proto has, rather than sent whole and rejected. `type` is a proto enum,
 * so it goes up-cased; a `["string","null"]` union collapses to its first real type.
 */
const GEMINI_SCHEMA_KEYS: Record<string, true> = {
  type: true, format: true, title: true, description: true, nullable: true, enum: true,
  items: true, properties: true, required: true, minItems: true, maxItems: true,
  minLength: true, maxLength: true, pattern: true, minimum: true, maximum: true,
  example: true, anyOf: true, propertyOrdering: true, default: true,
};
export function geminiSchema(sch: unknown): unknown {
  if (Array.isArray(sch)) return sch.map(geminiSchema);
  if (!sch || typeof sch !== "object") return sch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sch)) {
    if (!GEMINI_SCHEMA_KEYS[k]) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, geminiSchema(ps)]));
    } else if (k === "items" || k === "anyOf") out[k] = geminiSchema(v);
    else if (k === "type") {
      const t = Array.isArray(v) ? v.find((x) => x !== "null") ?? "string" : v;
      if (typeof t === "string") { out.type = t.toUpperCase(); if (Array.isArray(v)) out.nullable = true; }
    } else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Gemini 3 refuses a transcript whose functionCall parts come back without the
 * `thoughtSignature` it issued ("Function call is missing a thought_signature ... required
 * for tools to work correctly" — observed live 2026-08-27), and the docs say so for
 * stateless mode in as many words: "You MUST always resend all thought blocks exactly as
 * they were received from the model."
 *
 * Neither the Anthropic nor the OpenAI dialect has a field to carry an opaque vendor blob
 * across a turn, and a client only ever echoes the tool-call ID — so the signature is
 * remembered HERE, keyed by that id. Process-local and bounded: a conversation that
 * outlives a server restart simply loses the signature and Gemini asks for it again — no
 * state on disk, no unbounded growth.
 *
 * ONE STORE FOR BOTH ROUTES, which is the reason it lives in the leaf rather than in either
 * adapter. The signature is the VENDOR's, not the route's: a conversation that starts on
 * the subscription and continues on the API key (or the reverse — a stale `agy` login
 * failing over to the key) must not lose it, and two stores would silently make the second
 * route re-request every signature the first one already held.
 *
 * A Map rather than a Record: the keys are runtime tool-call ids, the size is read to
 * enforce the bound, and the insertion order is what makes the eviction below oldest-first.
 */
const SIGS = new Map<string, string>();
const SIGS_MAX = 2000;
export function rememberToolSig(id: string, sig: string) {
  if (!id || !sig) return;
  if (SIGS.size >= SIGS_MAX) SIGS.delete(SIGS.keys().next().value as string);
  SIGS.set(id, sig);
}
export const recallToolSig = (id: string): string | undefined => SIGS.get(id);

/** Anthropic-style content (string | block array | anything) flattened to plain text.
 *  Kept here rather than imported so this module stays a leaf; providers.ts exports its own
 *  `flatText` for the callers that predate this file, and the two agree by construction. */
function flatText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(flatText).join("");
  if (c === undefined || c === null) return "";
  if (c && typeof c === "object" && "text" in c && typeof c.text === "string") return c.text;
  return JSON.stringify(c);
}

const safeJson = (v: string): unknown => {
  try { const j: unknown = JSON.parse(v); return j && typeof j === "object" ? j : {}; } catch { return {}; }
};

/**
 * A Turn → a Gemini `Content`.
 *
 * Role mapped (assistant→model). Images sent INLINE as base64 — the measured-correct
 * choice, since routing the frame through an agent tool cost an extra model turn (~2.5s)
 * for nothing the model could not read from the bytes. A tool RESULT is named by the
 * FUNCTION rather than by the call's id, which is Gemini's convention and both other
 * dialects' opposite, so the mapping is passed in: it exists only in the transcript.
 *
 * `isSystem` is deliberately ignored: Gemini has no mid-conversation system role, so a
 * flagged turn stays a `user` turn IN POSITION, which is what the flag protects. That is
 * why `honoursMidConversationInstruction` is false for both Google routes and the roster
 * never advertises the capability for either.
 */
export function toGeminiContent(t: Turn, nameOf?: Map<string, string>): { role: "user" | "model"; parts: unknown[] } {
  const parts: unknown[] = [];
  for (const r of t.toolResults ?? []) {
    parts.push({ functionResponse: {
      name: nameOf?.get(r.toolUseId) ?? r.toolUseId ?? "tool",
      response: { output: flatText(r.content) },
    } });
  }
  if (t.text) parts.push({ text: t.text });
  for (const im of t.images ?? []) {
    if (im.base64) parts.push({ inlineData: { mimeType: im.mediaType ?? "image/png", data: im.base64 } });
    else if (im.url) parts.push({ fileData: { mimeType: im.mediaType ?? "image/png", fileUri: im.url } });
  }
  for (const u of t.toolUses ?? []) {
    const sig = recallToolSig(u.id);
    parts.push({
      functionCall: { name: u.name, args: typeof u.input === "string" ? safeJson(u.input) : (u.input ?? {}) },
      ...(sig ? { thoughtSignature: sig } : {}),
    });
  }
  // An empty part array is a 400; a single space is the smallest legal stand-in.
  if (!parts.length) parts.push({ text: " " });
  return { role: t.role === "assistant" ? "model" : "user", parts };
}
