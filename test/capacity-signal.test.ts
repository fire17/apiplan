/**
 * capacity-signal.test.ts — apiplan as the producer of OM's park/resume capacity signals.
 *
 * Everything here runs from fixtures: `src/capacity-signal.ts` is pure, so there is no network, no
 * keychain, no clock and no credential file involved.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NEAR_EXHAUSTED_FRACTION, assertNoSecrets, capacityRecordFromResponse, diffCapacity, diffCapacityTable,
  fingerprintAccount, isExhausted, observationFromResponse, observationKey, parseResetValue, recordToObservation,
} from "../src/capacity-signal";
import type { CapacityObservation } from "../src/capacity-signal";

const T0 = 1_700_000_000_000;
const obs = (over: Partial<CapacityObservation> = {}): CapacityObservation => ({ provider: "anthropic", at: T0, account: "a:1111aaaa2222", ...over });

describe("diffCapacity — no change is no news", () => {
  test("the first observation is a baseline and emits nothing", () => {
    expect(diffCapacity(undefined, obs({ limited: true }))).toEqual([]);
  });

  test("two identical observations emit nothing", () => {
    const a = obs({ limited: false });
    expect(diffCapacity(a, { ...a, at: T0 + 30_000 })).toEqual([]);
  });

  test("still limited emits nothing, however many times it is polled", () => {
    const blocked = obs({ limited: true, resetsAt: T0 + 600_000 });
    for (let i = 1; i <= 20; i++) expect(diffCapacity(blocked, { ...blocked, at: T0 + i * 15_000 })).toEqual([]);
  });

  test("a different provider on either side is not diffed", () => {
    expect(diffCapacity(obs({ provider: "openai", limited: true }), obs({ limited: false }))).toEqual([]);
  });
});

describe("diffCapacity — window reset", () => {
  test("limited → not limited emits exactly one window-reset", () => {
    const signals = diffCapacity(obs({ limited: true, resetsAt: T0 + 600_000 }), obs({ at: T0 + 600_001, limited: false }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      kind: "window-reset", at: T0 + 600_001, source: "apiplan:usage-poll",
      provider: "anthropic", accountFingerprint: "a:1111aaaa2222", detail: "usage window reopened",
    });
  });

  test("and then repeated polls of the reopened window emit nothing", () => {
    const open = obs({ at: T0 + 600_001, limited: false });
    expect(diffCapacity(open, { ...open, at: T0 + 700_000 })).toEqual([]);
    expect(diffCapacity(open, { ...open, at: T0 + 800_000 })).toEqual([]);
  });

  test("an announced reset time that moves forward is a reset even without a limited→open edge", () => {
    const before = obs({ limited: false, resetsAt: T0 + 100 });
    const after = obs({ at: T0 + 5_000, limited: false, resetsAt: T0 + 3_600_000 });
    expect(diffCapacity(before, after).map(s => s.kind)).toEqual(["window-reset"]);
    expect(diffCapacity(before, after)[0]!.detail).toBe("announced reset time advanced");
  });

  test("remaining capacity crossing back over the near-exhausted threshold is a reset", () => {
    expect(isExhausted(obs({ remainingFraction: NEAR_EXHAUSTED_FRACTION }))).toBe(true);
    expect(isExhausted(obs({ remainingFraction: 0.5 }))).toBe(false);
    const signals = diffCapacity(obs({ remainingFraction: 0.01 }), obs({ at: T0 + 60_000, remainingFraction: 0.4 }));
    expect(signals.map(s => s.kind)).toEqual(["window-reset"]);
    expect(signals[0]!.detail).toBe("remaining capacity increased");
    // and a drop is never good news
    expect(diffCapacity(obs({ remainingFraction: 0.4 }), obs({ at: T0 + 60_000, remainingFraction: 0.01 }))).toEqual([]);
  });
});

describe("diffCapacity — account change", () => {
  test("a swapped fingerprint emits exactly one account-changed", () => {
    const signals = diffCapacity(obs({ account: "a:1111aaaa2222", limited: true }), obs({ at: T0 + 5, account: "a:3333bbbb4444", limited: true }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "account-changed", accountFingerprint: "a:3333bbbb4444", provider: "anthropic", at: T0 + 5 });
    expect(signals[0]!.detail).toBe("active account changed a:1111aaaa2222 → a:3333bbbb4444");
  });

  test("a swap that ALSO reopens the window emits both, account-changed first", () => {
    const signals = diffCapacity(obs({ account: "a:1111aaaa2222", limited: true }), obs({ at: T0 + 5, account: "a:3333bbbb4444", limited: false }));
    expect(signals.map(s => s.kind)).toEqual(["account-changed", "window-reset"]);
  });

  test("an unknown fingerprint on either side is never reported as a switch", () => {
    expect(diffCapacity(obs({ account: undefined, limited: true }), obs({ limited: true }))).toEqual([]);
    expect(diffCapacity(obs({ limited: true }), obs({ account: undefined, limited: true }))).toEqual([]);
  });
});

describe("no credentials, ever", () => {
  const REFRESH = "1//0gSECRETrefreshTOKENvalue0123456789abcdef";
  const ACCESS = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF";

  test("a fixture full of secrets cannot produce a signal that contains any of them", () => {
    const before = obs({ account: fingerprintAccount(REFRESH, "g"), limited: true, note: "quota exhausted" });
    const after = obs({ at: T0 + 1, account: fingerprintAccount(REFRESH + "-rotated", "g"), limited: false, note: "window reopened" });
    const signals = diffCapacity(before, after);
    const blob = JSON.stringify(signals);
    expect(signals.length).toBeGreaterThan(0);
    expect(blob).not.toContain(REFRESH);
    expect(blob).not.toContain(ACCESS);
    expect(blob).not.toContain("SECRET");
  });

  test("assertNoSecrets refuses a hand-built signal that leaked one", () => {
    expect(() => assertNoSecrets([{ kind: "manual", at: T0, source: "x", detail: `Bearer ${ACCESS}` }])).toThrow(/credential-shaped/);
    expect(() => assertNoSecrets([{ kind: "manual", at: T0, source: "x", detail: "ops.person@example.com" }])).toThrow(/credential-shaped/);
    expect(() => assertNoSecrets([{ kind: "manual", at: T0, source: "x", detail: `refresh ${REFRESH}` }])).toThrow(/credential-shaped/);
    expect(() => assertNoSecrets([{ kind: "manual", at: T0, source: "x", detail: "window reopened" }])).not.toThrow();
  });

  test("fingerprintAccount reproduces src/providers.ts:1219 exactly", () => {
    // providers.ts:1219 — `"g:" + createHash("sha256").update(rt).digest("hex").slice(0, 12)`
    const expected = "g:" + createHash("sha256").update(REFRESH).digest("hex").slice(0, 12);
    expect(fingerprintAccount(REFRESH, "g")).toBe(expected);
    expect(fingerprintAccount(REFRESH, "g")).toMatch(/^g:[0-9a-f]{12}$/);
    // a rotated ACCESS token for the same account must not change it: this module only ever sees
    // the refresh-derived fingerprint, which is the whole point of providers.ts:1205-1211.
    expect(fingerprintAccount(REFRESH, "g")).toBe(fingerprintAccount(REFRESH, "g"));
  });
});

describe("glue and tables", () => {
  test("observationFromResponse reads a 429 with retry-after exactly as engine.ts does", () => {
    const o = observationFromResponse({ provider: "anthropic", at: T0, account: "a:1111aaaa2222", status: 429, retryAfterSeconds: "60" });
    expect(o).toMatchObject({ limited: true, resetsAt: T0 + 60_000 });
    const normalised = observationFromResponse({ provider: "google", at: T0, errorType: "rate_limit_error" });
    expect(normalised.limited).toBe(true);
    expect(normalised.resetsAt).toBeUndefined();          // no retry-after ⇒ no invented reset time
    const fine = observationFromResponse({ provider: "openai", at: T0, status: 200 });
    expect(fine.limited).toBe(false);
    expect(observationFromResponse({ provider: "x", at: T0, status: 429, retryAfterSeconds: null }).resetsAt).toBeUndefined();
  });

  test("diffCapacityTable tracks several providers and survives an account switch", () => {
    let state = new Map<string, CapacityObservation>();
    let r = diffCapacityTable(state, [obs({ limited: true, resetsAt: T0 + 600_000 }), obs({ provider: "openai", account: "o:aaaa", limited: false })]);
    expect(r.signals).toEqual([]);                        // baseline
    state = r.state;
    expect([...state.keys()]).toEqual(["anthropic|a:1111aaaa2222", "openai|o:aaaa"]);

    // the human switches account: a NEW fingerprint on the anthropic line, window open again
    r = diffCapacityTable(state, [obs({ at: T0 + 5_000, account: "a:3333bbbb4444", limited: false }), obs({ provider: "openai", at: T0 + 5_000, account: "o:aaaa", limited: false })]);
    expect(r.signals.map(s => `${s.provider}:${s.kind}`)).toEqual(["anthropic:account-changed", "anthropic:window-reset"]);
    state = r.state;
    expect([...state.keys()]).toEqual(["openai|o:aaaa", "anthropic|a:3333bbbb4444"]);

    // and polling again with no change is silent
    expect(diffCapacityTable(state, [obs({ at: T0 + 9_000, account: "a:3333bbbb4444", limited: false }), obs({ provider: "openai", at: T0 + 9_000, account: "o:aaaa", limited: false })]).signals).toEqual([]);
  });

  test("observationKey is provider plus fingerprint", () => {
    expect(observationKey(obs())).toBe("anthropic|a:1111aaaa2222");
    expect(observationKey(obs({ account: undefined }))).toBe("anthropic|");
  });
});

describe("the capacity record (U11) — what apiplan learns from a refusal", () => {
  const T = 1_700_000_000_000;

  test("a 429 with a relative retry-after yields a reset instant", () => {
    const r = capacityRecordFromResponse({ provider: "anthropic", at: T, account: "a:1111aaaa2222", status: 429, headers: { "retry-after": "60" } });
    expect(r).toMatchObject({ limited: true, resetsAt: T + 60_000, source: "retry-after", scope: "unknown" });
  });

  test("the unified reset header wins over retry-after, and every live encoding is accepted", () => {
    const iso = new Date(T + 3_600_000).toISOString();
    expect(capacityRecordFromResponse({ provider: "anthropic", at: T, status: 429, headers: { "anthropic-ratelimit-unified-reset": iso, "retry-after": "5" } }))
      .toMatchObject({ resetsAt: T + 3_600_000, source: "anthropic-ratelimit-unified-reset" });
    expect(parseResetValue("30", T)).toBe(T + 30_000);                       // relative seconds
    expect(parseResetValue(String(Math.floor((T + 1000) / 1000)), T)).toBe(T + 1000); // epoch seconds
    expect(parseResetValue(String(T + 1000), T)).toBe(T + 1000);             // epoch milliseconds
    expect(parseResetValue(iso, T)).toBe(T + 3_600_000);                     // RFC 3339
    // anything else must NOT become a fabricated wake-up time
    expect(parseResetValue("Wed, 21 Oct 2015 07:28:00 GMT", T)).toBe(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")); // HTTP-date
    // Date.parse alone is not a validator: JavaScriptCore turns "soon" into a real instant
    expect(parseResetValue("soon", T)).toBeUndefined();
    expect(parseResetValue("later today", T)).toBeUndefined();
    expect(parseResetValue("", T)).toBeUndefined();
    expect(parseResetValue(null, T)).toBeUndefined();
    expect(parseResetValue(-5, T)).toBeUndefined();
  });

  test("apiplan's own normalised error name is enough, with or without headers", () => {
    expect(capacityRecordFromResponse({ provider: "google", at: T, errorType: "rate_limit_error" })).toMatchObject({ limited: true, resetsAt: undefined, source: "error:rate_limit_error" });
    // a billing refusal is a capacity failure no reset time will ever clear
    expect(capacityRecordFromResponse({ provider: "openai", at: T, status: 402 })).toMatchObject({ limited: true, resetsAt: undefined });
    expect(capacityRecordFromResponse({ provider: "openai", at: T, status: 200, headers: { "retry-after": "60" } })).toMatchObject({ limited: false, resetsAt: undefined });
  });

  test("it reads a Headers object as happily as a plain bag, case-insensitively", () => {
    const h = new Headers({ "Retry-After": "120" });
    expect(capacityRecordFromResponse({ provider: "anthropic", at: T, status: 429, headers: h }).resetsAt).toBe(T + 120_000);
    expect(capacityRecordFromResponse({ provider: "anthropic", at: T, status: 429, headers: { "X-Retry-After": "10" } }).resetsAt).toBe(T + 10_000);
  });

  test("a record feeds straight into the diff, and no upstream detail can smuggle a credential", () => {
    const before = recordToObservation(capacityRecordFromResponse({ provider: "anthropic", at: T, account: "a:1111aaaa2222", status: 429, headers: { "retry-after": "60" } }));
    const after = recordToObservation(capacityRecordFromResponse({ provider: "anthropic", at: T + 61_000, account: "a:1111aaaa2222", status: 200 }));
    expect(diffCapacity(before, after).map(s => s.kind)).toEqual(["window-reset"]);

    const leaky = capacityRecordFromResponse({ provider: "anthropic", at: T, status: 429, detail: "refused for sk-ant-api03-AAAABBBBCCCCDDDD (ops.person@example.com)" });
    expect(JSON.stringify(leaky)).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDD");
    expect(JSON.stringify(leaky)).not.toContain("ops.person@example.com");
  });
});
