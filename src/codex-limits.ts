// codex-limits.ts — Responses-API fault names and Codex capacity facts, read in ONE place.
//
// A LEAF (no runtime imports), for the same reason responses-wire.ts is one: api.ts and any
// future adapter can depend on it without a cycle. Written 2026-09-29 for GPT-6 through OM:
//   · the Codex backend names a fault in `error.code` as often as in `error.type`
//     (`usage_limit_reached`, `server_is_overloaded`, `invalid_encrypted_content`, …), and an
//     Anthropic-dialect client (OM, Claude SDKs) branches its retry policy on the Anthropic
//     vocabulary. Unmapped, a usage-limit 429 reached OM as a type it does not know.
//   · a Codex usage-limit refusal says WHEN it resets in the body (`resets_in_seconds` /
//     `resets_at`) or in `x-codex-*-reset-after-seconds` headers, while capacity-signal.ts
//     reads `retry-after`. Rather than edit that file (dirty WIP owned by nobody), this module
//     hands it a header bag with a synthesized `retry-after` — a header it already parses.

/** Responses-API fault names → the Anthropic type an OM/Claude-SDK retry policy reads.
 *  The vendor's own name stays in the MESSAGE (api.ts appends it) — never lost. */
const ALIAS: Record<string, string> = {
  rate_limit_exceeded: "rate_limit_error", usage_limit_reached: "rate_limit_error",
  server_is_overloaded: "overloaded_error", overloaded: "overloaded_error",
  insufficient_quota: "billing_error", server_error: "api_error",
  context_length_exceeded: "invalid_request_error", invalid_encrypted_content: "invalid_request_error",
  unsupported_value: "invalid_request_error",
};
export function responsesFaultAlias(t?: string): string | undefined { return t ? (ALIAS[t] ?? t) : t; }

const posNum = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * A header bag capacityRecordFromResponse() can read: the original headers plus a synthesized
 * `retry-after` (whole seconds) from, in order: body error.resets_in_seconds, body
 * error.resets_at (epoch seconds), and the exhausted Codex window's
 * x-codex-{primary,secondary}-reset-after-seconds (only a window whose used-percent >= 100). Never overrides a real `retry-after`. Returns the SAME object when there is
 * nothing to add, so a caller comparing identities sees "unchanged".
 */
export function codexCapacityHeaders(h: Headers | undefined, body: any, now = Date.now()): Headers | undefined {
  if (h?.get("retry-after")) return h;
  const err = body?.error ?? body;
  let secs = posNum(err?.resets_in_seconds);
  if (secs === undefined) {
    const at = posNum(err?.resets_at);
    if (at !== undefined) { const d = at - now / 1000; if (d > 0) secs = d; }
  }
  if (secs === undefined && h) {
    const used = (w: string) => posNum(h.get(`x-codex-${w}-used-percent`)) ?? 0;
    // Only an EXHAUSTED window explains a refusal; a burst 429 with both windows open must
    // not borrow a reset hours away.
    const win = used("primary") >= 100 ? "primary" : used("secondary") >= 100 ? "secondary" : undefined;
    if (win) secs = posNum(h.get(`x-codex-${win}-reset-after-seconds`));
  }
  if (secs === undefined) return h;
  const out = new Headers(h ?? {});
  out.set("retry-after", String(Math.ceil(secs)));
  return out;
}
