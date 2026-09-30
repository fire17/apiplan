// responses-wire.ts — the OpenAI RESPONSES wire shape, read and written in ONE place.
//
// WHY THIS IS ITS OWN MODULE. Two subscription backends here speak this shape, and neither
// of them is the other's parent:
//   · openai — the Codex/ChatGPT endpoint (`/backend-api/codex/responses`), in providers.ts;
//   · grok   — the xAI subscription proxy, whose OWN catalog declares
//              `api_backend: "responses"` (~/.grok/models_cache.json), in providers-grok.ts.
// Both vendors document the same event vocabulary and, for usage, the same three field
// names: `input_tokens`, `output_tokens`, and `input_tokens_details.cached_tokens`.
//
// These readers lived in providers.ts, where the `openai` adapter was written. Importing
// them from providers-grok.ts made a CYCLE — providers.ts imports the grok provider to put
// it in PROVIDERS, and providers-grok.ts imported providers.ts for the helpers — and that
// cycle is not a style problem: it is a real temporal-dead-zone crash. Bun/ESM evaluated
// providers-grok.ts first, which re-entered a providers.ts that had not yet initialised its
// own bindings, and `PROVIDERS = { … , grok }` threw `ReferenceError: Cannot access '…'
// before initialization` at import time. Every test in the file died before the first
// assertion ran.
//
// The fix is directional rather than defensive: this module is a LEAF. It imports nothing
// from providers.ts at runtime — only `type` declarations, which ESM erases entirely — so
// both adapters can depend on it and neither depends on the other. Copying the readers into
// the grok adapter would have broken the cycle too, and would have been the wrong repair: a
// second parser for one wire shape is how two backends drift into disagreeing about what the
// same event meant, which is precisely the class of bug this gateway exists to prevent.
import type { Delta, Turn } from "./providers.ts";
import { wireNum, wireObj } from "./wire.ts";

/** Anthropic-style content (string | block array | anything) flattened to plain text.
 *  Kept here rather than imported so this module stays a leaf; providers.ts exports its own
 *  `flatText` for the callers that predate this file, and the two agree by construction. */
function flatText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && "type" in b) {
        const blk = b as { type?: unknown; text?: unknown };
        return blk.type === "text" ? (typeof blk.text === "string" ? blk.text : "") : `[${String(blk.type ?? "block")}]`;
      }
      return "[block]";
    }).join("\n");
  }
  return c == null ? "" : JSON.stringify(c);
}

/**
 * The Responses-API usage object → this gateway's buckets. Served by more than one backend
 * here (the Codex subscription endpoint and, per its own catalog's
 * `api_backend: "responses"`, the Grok subscription proxy), and both vendors document the
 * SAME three field names — `input_tokens`, `output_tokens` and
 * `input_tokens_details.cached_tokens`. One reader for one wire shape: a second copy is how
 * two backends drift into disagreeing about what the same event meant.
 *
 * The cached count is passed THROUGH unsubtracted. Both vendors declare `usageBasis:
 * "inclusive"` and normalizeTally() owns the single conversion; subtracting here as well
 * would double-subtract and trip its source-inconsistent guard.
 *
 * WHAT EACH VENDOR DOCUMENTS ON THIS SHAPE, AND WHERE IT GOES:
 *   input_tokens                              → input
 *   output_tokens                             → output
 *   input_tokens_details.cached_tokens         → cacheRead
 *   input_tokens_details.cache_write_tokens    → cacheWrite   (absent on xAI, measured:
 *                                                that vendor states no write counter at
 *                                                all, which is an ABSENCE and not a drop)
 *   output_tokens_details.reasoning_tokens     → reasoning    a sub-division of output
 *   total_tokens                  NOT carried: input + output by definition, and both
 *                                 fronts compute their own total from the numbers they
 *                                 publish. Carrying a second total invites two answers.
 *   context_details.{input,output}_tokens (xAI)
 *                                 NOT carried: xAI's own re-description of the same two
 *                                 counters; no front dialect has a field for it.
 *   num_sources_used / num_server_side_tools_used (xAI)
 *                                 NOT carried: request counts for xAI's server-side tools,
 *                                 and no dialect this gateway serves defines a field for
 *                                 them (the Anthropic front's `server_tool_use` is that
 *                                 vendor's own object, so filling it from xAI's counters
 *                                 would attribute one vendor's number to another).
 *   cost_in_usd_ticks (xAI)       NOT carried, deliberately: this gateway re-partitions
 *                                 token counts and never turns them into money. What a
 *                                 token costs stays the reader's business.
 *   orchestration_input_tokens / orchestration_input_cached_tokens /
 *   orchestration_output_tokens   NOT carried. A consumer that reads them treats them as a
 *                                 SEPARATE accounting lane — its own input/cacheRead/output
 *                                 triple, kept apart from the primary turn and only after
 *                                 deciding, from `total_tokens`, whether the primary
 *                                 counters already contain them. This gateway's Delta has
 *                                 exactly one lane, so there is nowhere to put them that
 *                                 does not either double-count the primary buckets or
 *                                 silently inflate one of them. Neither front dialect
 *                                 defines the fields either, so re-emitting them would
 *                                 invent a vendor field on the way out. Recorded here as a
 *                                 known, deliberate omission rather than an oversight: the
 *                                 honest fix is a second lane on Delta.usage, which is a
 *                                 design change, not a field forward.
 *
 * REASONING IS A SUB-DIVISION, NEVER AN ADDEND. This vendor's `reasoning_tokens` is already
 * inside `output_tokens` — xAI says so in its pricing ("reasoning tokens … full completion
 * token price"), and OpenAI's own accounting treats it the same way. Adding it to output
 * would bill the same tokens twice.
 */
export const responsesUsage = (r: unknown): Delta["usage"] | undefined => {
  const u = wireObj(r, "usage");
  if (!u) return undefined;
  const details = wireObj(u, "input_tokens_details"), out = wireObj(u, "output_tokens_details");
  const input = wireNum(u, "input_tokens"), output = wireNum(u, "output_tokens");
  const cacheRead = wireNum(details, "cached_tokens"), cacheWrite = wireNum(details, "cache_write_tokens");
  const reasoning = wireNum(out, "reasoning_tokens");
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
};

/** Responses-API completion status -> Anthropic's stop vocabulary. Only a real
 *  output-cap truncation becomes "max_tokens"; everything else is an end_turn. */
export const responsesStop = (r: any): string =>
  r?.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "end_turn";

/** The handle every event of one function call agrees on: the OUTPUT ITEM id. The added/
 *  done events carry it as `item.id`, the argument events as `item_id`; output_index is
 *  the last resort, and is the only field present on all three when a backend omits ids. */
export const fnRef = (ev: any): string => String(ev?.item?.id ?? ev?.item_id ?? ev?.item?.call_id ?? ev?.output_index ?? 0);

/** JSON-Schema framing that is not a parameter schema. `$schema` in particular makes the
 *  Responses backend inconsistent, and no model needs it to call a tool. */
export function stripSchemaMeta(sch: any): any {
  if (!sch || typeof sch !== "object" || Array.isArray(sch)) return sch;
  const { $schema, $id, ...rest } = sch as any;
  return rest;
}

/**
 * The Responses API names a fault in `type`, or failing that in `code`. Carried rather than
 * re-derived: a client that retries on one label and gives up on another makes the opposite
 * decision when the name is flattened away.
 *
 * Named `responsesErrType` here because it belongs to the WIRE SHAPE, not to one vendor —
 * xAI's proxy reports faults in the same two fields. providers.ts re-exports it under its
 * historical name `openaiErrType` so no existing caller changes.
 */
export const responsesErrType = (e: any) =>
  typeof e?.type === "string" ? { errorType: e.type }
  : typeof e?.code === "string" ? { errorType: e.code } : {};

/**
 * One Turn → its Responses items. A turn can be SEVERAL: a tool result and a tool call are
 * top-level items there, not content blocks of a message. User content is
 * input_text/input_image, assistant is output_text.
 */
export function toResponsesItems(t: Turn): any[] {
  // A4: an assistant turn carrying a reasoning item THIS gateway minted is replayed in its
  // original block order (reasoning → message → function_call). Every other turn keeps the
  // legacy path below byte-for-byte, so no cached prefix moves.
  const native = t.role === "assistant" && reasoningReplayOn() ? t.nativeAnthropicContent : undefined;
  if (native?.some(isApiplanThinking)) return orderedAssistantItems(native);
  // The Responses API spells a mid-conversation instruction turn "developer".
  const role = t.isSystem ? "developer" : t.role;
  const items: any[] = [];
  for (const r of t.toolResults ?? []) {
    items.push({ type: "function_call_output", call_id: r.toolUseId, output: toolOutputOf(r.content) });
  }
  const content: any[] = [];
  if (t.role === "assistant") {
    if (t.text) content.push({ type: "output_text", text: t.text });
  } else {
    if (t.text) content.push({ type: "input_text", text: t.text });
    for (const im of t.images ?? []) {
      content.push({ type: "input_image", image_url: im.url ?? `data:${im.mediaType};base64,${im.base64}` });
    }
  }
  if (content.length) items.push({ type: "message", role, content });
  for (const u of t.toolUses ?? []) {
    items.push({ type: "function_call", call_id: u.id, name: u.name, arguments: typeof u.input === "string" ? u.input : JSON.stringify(u.input ?? {}) });
  }
  // A turn that carried only blocks this backend cannot express still has to exist.
  if (!items.length) items.push({ type: "message", role, content: [{ type: t.role === "assistant" ? "output_text" : "input_text", text: t.text || " " }] });
  return items;
}

// ───────────── tool-result images (G-a, 2026-09-29) ─────────────

/** A tool result → the Responses `function_call_output.output`. Text-only results stay a
 *  STRING, byte-identical to the old flatText() (so every cached prefix stays stable).
 *  Any image makes it an ARRAY of input_text / input_image parts, in order — live-proven
 *  on gpt-6-luna 2026-09-29 (a red PNG read back as "Red"; flattened to "[image]" the model
 *  guessed "White"/"Blue"). This is how an OM agent loop sees a screenshot or image-read. */
export function toolOutputOf(content: unknown): string | any[] {
  const parts = Array.isArray(content) ? content : null;
  if (!parts || !parts.some(isImagePart)) return flatText(content);
  const out: any[] = [];
  for (const b of parts) {
    if (typeof b === "string") { if (b) out.push({ type: "input_text", text: b }); continue; }
    if (!b || typeof b !== "object") continue;
    const blk = b as any;
    if (blk.type === "text" && typeof blk.text === "string") { if (blk.text) out.push({ type: "input_text", text: blk.text }); }
    else if (isImagePart(blk)) {
      // An OpenAI part's own `image_url.detail` wins; withImageDetail() only fills a missing one.
      const u = imageUrlOf(blk);
      const d = blk.type === "image_url" && typeof blk.image_url === "object" ? blk.image_url?.detail : undefined;
      if (u) out.push({ type: "input_image", image_url: u, ...(typeof d === "string" && d ? { detail: d } : {}) });
    }
    else out.push({ type: "input_text", text: `[${String(blk.type ?? "block")}]` });
  }
  return out.length ? out : " ";
}
// Anthropic {type:"image",source:{type:"base64",media_type,data}|{type:"url",url}}
// OpenAI    {type:"image_url",image_url:{url}|string}
const isImagePart = (b: any) => !!b && typeof b === "object" && (b.type === "image" || b.type === "image_url");
function imageUrlOf(b: any): string | undefined {
  if (b.type === "image_url") { const u = b.image_url?.url ?? b.image_url; return typeof u === "string" ? u : undefined; }
  const s = b.source;
  if (s?.type === "url" && typeof s.url === "string") return s.url;
  if (typeof s?.data === "string") return `data:${s.media_type ?? "image/png"};base64,${s.data}`;
  return undefined;
}

// ───────────── A4: stateless reasoning replay through an Anthropic-only client ─────────────
//
// The Codex backend runs `store:false`, so a reasoning item the model produced on turn N is
// gone on turn N+1 unless the CLIENT sends it back (codex-rs does, as a `reasoning` input item
// carrying `encrypted_content`). OM only speaks Anthropic, whose only opaque carrier that is
// echoed verbatim is `thinking.signature`. So the gateway mints a thinking block whose
// signature is a versioned envelope around the reasoning item, and unwraps it on replay.
// Live 2026-09-29 (gpt-6-luna @max, same tool loop): with replay 1.8 s / 0 reasoning tokens,
// without 11.2 s / 428. Replay WITHOUT `id` (codex-rs skips ids; with id it re-reasoned).

/** Prefix on the Anthropic `thinking.signature` that carries a Responses reasoning item. */
export const REASONING_SIG_PREFIX = "apiplan.rs.v1.";
export type ReasoningItem = { encrypted_content: string; summary: any[] };
/** Kill switch, read per call (tests flip it). */
export const reasoningReplayOn = () => process.env.APIPLAN_REASONING_REPLAY !== "0";

/** Raw Responses event → the reasoning item it completes, or undefined. */
export function reasoningItemOf(ev: any): ReasoningItem | undefined {
  if (ev?.type !== "response.output_item.done" || ev.item?.type !== "reasoning") return undefined;
  const e = ev.item.encrypted_content;
  if (typeof e !== "string" || !e) return undefined;
  return { encrypted_content: e, summary: Array.isArray(ev.item.summary) ? ev.item.summary : [] };
}
/** base64url(JSON{v,m,e,s}). `m` = the producing model id (diagnostics only; a luna item
 *  was accepted by sol live, so it does not gate replay). */
export function encodeReasoningSig(it: ReasoningItem, model: string): string {
  const json = JSON.stringify({ v: 1, m: model, e: it.encrypted_content, s: it.summary });
  return REASONING_SIG_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}
export function decodeReasoningSig(sig: unknown): (ReasoningItem & { model: string }) | undefined {
  if (typeof sig !== "string" || !sig.startsWith(REASONING_SIG_PREFIX)) return undefined;
  try {
    const j = JSON.parse(Buffer.from(sig.slice(REASONING_SIG_PREFIX.length), "base64url").toString("utf8"));
    if (j?.v !== 1 || typeof j.e !== "string" || !j.e) return undefined;
    return { encrypted_content: j.e, summary: Array.isArray(j.s) ? j.s : [], model: String(j.m ?? "") };
  } catch { return undefined; }
}
/** A thinking block this gateway minted (any version of the prefix). */
export const isApiplanThinking = (b: unknown): boolean =>
  !!b && typeof b === "object" && (b as any).type === "thinking" &&
  typeof (b as any).signature === "string" && (b as any).signature.startsWith("apiplan.rs.");
/** A thinking block NO backend but ours can accept: ours, or unsigned. Stripped before any
 *  non-openai build, because the Anthropic adapter forwards native blocks verbatim. */
export const isForeignThinking = (b: unknown): boolean =>
  !!b && typeof b === "object" && (b as any).type === "thinking" &&
  (isApiplanThinking(b) || !(typeof (b as any).signature === "string" && (b as any).signature.trim()));
/** Force `include` on a Responses body (belt: the backend sends encrypted_content without
 *  it today, but codex-rs always asks, and a silent default can change). Idempotent. */
export function withReasoningInclude(body: any): void {
  const inc = new Set<string>(Array.isArray(body.include) ? body.include : []);
  inc.add("reasoning.encrypted_content");
  body.include = [...inc];
}

/** Assistant blocks → Responses items IN THEIR ORIGINAL ORDER. Only reached when the turn
 *  carries a reasoning item we minted. Consecutive text blocks merge with "\n" exactly as
 *  partsToTurn() merges them. */
function orderedAssistantItems(blocks: unknown[]): any[] {
  const items: any[] = []; let text = "";
  const flush = () => { if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }); text = ""; };
  for (const b of blocks as any[]) {
    if (b?.type === "text" && typeof b.text === "string") { text += (text ? "\n" : "") + b.text; continue; }
    if (b?.type === "thinking") {
      const r = decodeReasoningSig(b.signature);
      if (r) { flush(); items.push({ type: "reasoning", summary: r.summary, encrypted_content: r.encrypted_content }); }
      continue;                                   // foreign/unsigned thinking: not expressible here
    }
    if (b?.type === "tool_use") {
      flush();
      items.push({ type: "function_call", call_id: String(b.id ?? ""), name: String(b.name ?? ""),
                   arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}) });
    }
    // redacted_thinking / server tools / anything else: skipped, as the legacy path does
  }
  flush();
  return items.length ? items : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: " " }] }];
}

/**
 * Wall-clock with its ZONE, for a credential-expiry line a human has to trust. An
 * unlabelled timestamp is a lie by omission — a reader three hours out of step on the one
 * number they use to decide whether a credential is about to die.
 *
 * Lives here, beside the adapters that need it, for the leaf property this module exists to
 * keep: providers.ts re-exports it under its historical name so no existing caller changes.
 * Eight lines of pure date arithmetic, no dependency, no behaviour to drift.
 */
export function stampZ(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();               // minutes EAST of UTC (JS reports the inverse)
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
       + ` ${off < 0 ? "-" : "+"}${p(Math.floor(a / 60))}${p(a % 60)}`;
}
