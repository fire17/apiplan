// wire.ts — the two guards every vendor's usage reader needs, and nothing else.
//
// Every counter this gateway publishes starts as a field on JSON some other company sent.
// The whole discipline of that reading is ONE distinction: a number the vendor STATED
// versus a field it did not state. Get it wrong in the permissive direction and an absent
// counter becomes a measured zero — which is not a smaller mistake than a wrong number, it
// is a worse one, because zero LOOKS measured. "The vendor reports no cache-write counter"
// and "the vendor measured zero cache writes" are different claims, and only one of them is
// ever true of a given response.
//
// So these two are the funnel: `unknown` in, a finite number (or a real object) or
// `undefined` out. A null, a string, a NaN, an Infinity or a missing key all read as NOT
// STATED. Nothing downstream has to re-litigate it.
//
// WHY ITS OWN MODULE, and why a two-function file is the right size for one. Three vendor
// usage readers now depend on these — `anthropicUsage`, `googleUsage` and `responsesUsage`
// — and the last of those had to move OUT of providers.ts to break a real import cycle
// (see responses-wire.ts). Had the guards stayed in providers.ts, the leaf that was
// extracted to end the cycle would have had to import back into the module it was
// extracted from, reinstating it. As a LEAF with no imports at all, this file can be
// depended on by anything, in any direction, forever.

/**
 * One numeric field of a vendor object, or undefined when the vendor did not state it.
 *
 * `Number.isFinite` is doing real work here, not decoration: `JSON.parse` will happily hand
 * back a value that is a number by `typeof` and useless as a count. A NaN propagates
 * silently through every arithmetic in api.ts and prints as "NaN" in a usage line; an
 * Infinity survives a `>` comparison against any threshold. Both are "not stated" as far as
 * a token count is concerned.
 */
export const wireNum = (o: unknown, k: string): number | undefined => {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/**
 * One nested object of a vendor object, or undefined. `typeof null === "object"` is the trap
 * this exists for: a vendor that sends `"input_tokens_details": null` would otherwise pass a
 * truthiness check and then throw on the first field read.
 */
export const wireObj = (o: unknown, k: string): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[k];
  return v && typeof v === "object" ? v : undefined;
};
