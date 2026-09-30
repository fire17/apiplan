/**
 * capacity-events.test.ts — proving the capacity producer is REAL rather than convincing.
 *
 * The interesting risk in this module is not that it breaks; it is that it works beautifully while
 * observing nothing. A timer that emits a signal every few minutes, a `probe()` that always says yes,
 * a producer whose only caller is this file — each would pass a naive suite and each would cost a
 * parked workflow its resume. So most of what follows asserts ABSENCE: that nothing is emitted when
 * nothing happened, that silence is never upgraded into good news, and that the one honest transition
 * is the only one that speaks.
 *
 * Everything runs against a throwaway state directory. No network, no credential file, no keychain,
 * and no reliance on the real `~/.apiplan`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPACITY_WIRE_VERSION, CapacityJournal, SNAPSHOT_STALE_MS,
  capacityState, createCapacityFeed, createProducerState, diffIdents,
  identsFromOutcomes, lineKey, readCapacitySnapshot, readOutcomeIdents, recordCapacity, windowResetEdge,
} from "../src/capacity-events";
import type { CapacitySignal } from "../src/capacity-signal";
import type { CapacitySnapshotEntry } from "../src/capacity-events";

const T0 = 1_700_000_000_000;

let dir: string;
let outcomes: string;
let journalPath: string;
let snapshotPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apiplan-capacity-"));
  outcomes = join(dir, "outcomes.json");
  journalPath = join(dir, "capacity-events.jsonl");
  snapshotPath = join(dir, "capacity-state.json");
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeOutcomes = (entries: Record<string, Record<string, unknown>>) =>
  writeFileSync(outcomes, JSON.stringify(entries, null, 2) + "\n");

/** An `outcomes.json` entry in the real shape `src/api.ts` writes. */
const entry = (ident: string, cred = "cred0000") => ({ ok: true, at: T0, detail: "accepted 12:00:00", cred, ident, exp: T0 + 3600_000 });

const line = (over: Partial<CapacitySnapshotEntry> = {}): CapacitySnapshotEntry => ({
  provider: "anthropic", account: "a:1111aaaa2222", state: "open", observedAt: T0, scope: "account", source: "status:200", ...over,
});

// ─── identity: only a real chain change is an account change ────────────────────────────────

describe("identsFromOutcomes — unknown is not a value", () => {
  test("reads the ident of each provider", () => {
    const m = identsFromOutcomes({ anthropic: entry("c83ab7e3160f"), google: entry("g:f10a9466039c") });
    expect(m.get("anthropic")).toBe("c83ab7e3160f");
    expect(m.get("google")).toBe("g:f10a9466039c");
  });

  test("an entry with a missing or empty ident is omitted, never recorded as the empty account", () => {
    const m = identsFromOutcomes({ anthropic: { ok: true, at: T0 }, openai: entry(""), google: entry("g:aaa") });
    expect(m.has("anthropic")).toBe(false);
    expect(m.has("openai")).toBe(false);
    expect([...m.keys()]).toEqual(["google"]);
  });

  test("junk shapes yield an empty map rather than throwing", () => {
    expect(identsFromOutcomes(null).size).toBe(0);
    expect(identsFromOutcomes([1, 2, 3]).size).toBe(0);
    expect(identsFromOutcomes("nope" as unknown).size).toBe(0);
  });
});

describe("readOutcomeIdents — an unreadable ledger is no observation", () => {
  test("an absent file reads as undefined, not as an empty world", () => {
    expect(readOutcomeIdents(join(dir, "nothing.json"))).toBeUndefined();
  });

  test("a torn or half-written file reads as undefined rather than as 'every identity vanished'", () => {
    writeFileSync(outcomes, '{"anthropic": {"ok": true, "ide');
    expect(readOutcomeIdents(outcomes)).toBeUndefined();
  });
});

describe("diffIdents — the only thing that counts as an account change", () => {
  test("a first sighting is a baseline and emits nothing", () => {
    const { signals } = diffIdents(new Map(), new Map([["anthropic", "aaa"]]), T0, "test");
    expect(signals).toEqual([]);
  });

  test("an unchanged identity emits nothing, however many times it is read", () => {
    const known = new Map<string, string>();
    diffIdents(known, new Map([["anthropic", "aaa"]]), T0, "test");
    for (let i = 1; i <= 50; i++) {
      const { signals } = diffIdents(known, new Map([["anthropic", "aaa"]]), T0 + i * 1000, "test");
      expect(signals).toEqual([]);
    }
  });

  test("a real chain change emits exactly one account-changed, fully attributed", () => {
    const known = new Map<string, string>();
    diffIdents(known, new Map([["anthropic", "aaa"]]), T0, "test");
    const { signals } = diffIdents(known, new Map([["anthropic", "bbb"]]), T0 + 1000, "apiplan:outcomes");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "account-changed",
      provider: "anthropic",
      accountFingerprint: "bbb",
      scope: "account",
      at: T0 + 1000,
      source: "apiplan:outcomes",
    });
  });

  test("provider and accountFingerprint are ALWAYS populated — omitting either is a wildcard downstream", () => {
    const known = new Map([["google", "g:one"]]);
    const { signals } = diffIdents(known, new Map([["google", "g:two"]]), T0, "test");
    expect(signals[0].provider).toBe("google");
    expect(signals[0].accountFingerprint).toBe("g:two");
  });

  test("a provider dropping out of the ledger is unknown, not a change, and does not erase its identity", () => {
    const known = new Map([["anthropic", "aaa"]]);
    const { signals } = diffIdents(known, new Map(), T0 + 1000, "test");
    expect(signals).toEqual([]);
    expect(known.get("anthropic")).toBe("aaa");
  });

  test("A → unknown → B reports exactly ONE change, not zero and not two", () => {
    const known = new Map<string, string>();
    diffIdents(known, new Map([["anthropic", "A"]]), T0, "test");
    expect(diffIdents(known, new Map(), T0 + 1000, "test").signals).toEqual([]);
    const { signals } = diffIdents(known, new Map([["anthropic", "B"]]), T0 + 2000, "test");
    expect(signals).toHaveLength(1);
    expect(signals[0].detail).toContain("A → B");
  });

  test("two providers changing at once emit one signal each, never one for the pair", () => {
    const known = new Map([["anthropic", "a1"], ["google", "g1"]]);
    const { signals } = diffIdents(known, new Map([["anthropic", "a2"], ["google", "g2"]]), T0, "test");
    expect(signals.map(s => s.provider).sort()).toEqual(["anthropic", "google"]);
  });
});

describe("the access-token refresh must never look like an account switch", () => {
  test("cred rotating hourly while ident holds emits nothing", () => {
    const known = new Map<string, string>();
    writeOutcomes({ anthropic: entry("chain-stays", "access-hour-1") });
    diffIdents(known, readOutcomeIdents(outcomes)!, T0, "test");
    // An hour later api.ts has re-minted the access token for the SAME account.
    writeOutcomes({ anthropic: entry("chain-stays", "access-hour-2") });
    const { signals } = diffIdents(known, readOutcomeIdents(outcomes)!, T0 + 3600_000, "test");
    expect(signals).toEqual([]);
  });
});

// ─── capacity is three-valued ───────────────────────────────────────────────────────────────

describe("capacityState — silence is not capacity", () => {
  test("an absent observation is unknown", () => {
    expect(capacityState(undefined)).toBe("unknown");
  });

  test("limited:undefined is UNKNOWN, never open — this is the false-resume trap", () => {
    expect(capacityState({ limited: undefined })).toBe("unknown");
  });

  test("limited true/false map to exhausted/open", () => {
    expect(capacityState({ limited: true })).toBe("exhausted");
    expect(capacityState({ limited: false })).toBe("open");
  });

  test("a reported remaining fraction decides, at or below the near-exhausted bound", () => {
    expect(capacityState({ remainingFraction: 0 })).toBe("exhausted");
    expect(capacityState({ remainingFraction: 0.02 })).toBe("exhausted");
    expect(capacityState({ remainingFraction: 0.5 })).toBe("open");
  });
});

describe("windowResetEdge — one transition speaks, the rest are silent", () => {
  test("exhausted → open is the signal", () => {
    const signal = windowResetEdge(line({ state: "exhausted" }), line({ state: "open", observedAt: T0 + 60_000 }), "test");
    expect(signal).toMatchObject({ kind: "window-reset", provider: "anthropic", accountFingerprint: "a:1111aaaa2222", at: T0 + 60_000 });
  });

  test("unknown → open is a first reading, NOT a recovery", () => {
    expect(windowResetEdge(line({ state: "unknown" }), line({ state: "open" }), "test")).toBeUndefined();
  });

  test("exhausted → unknown is a lost reading, not a recovery", () => {
    expect(windowResetEdge(line({ state: "exhausted" }), line({ state: "unknown" }), "test")).toBeUndefined();
  });

  test("no prior state emits nothing — a fresh consumer never mistakes the world for news", () => {
    expect(windowResetEdge(undefined, line({ state: "open" }), "test")).toBeUndefined();
  });

  test("open → open with a later reset instant is a rolling window boundary, not a reset", () => {
    const before = line({ state: "open", resetsAt: T0 + 3600_000 });
    const after = line({ state: "open", resetsAt: T0 + 7200_000, observedAt: T0 + 60_000 });
    expect(windowResetEdge(before, after, "test")).toBeUndefined();
  });

  test("still exhausted emits nothing however many times it is observed", () => {
    for (let i = 1; i <= 20; i++) {
      expect(windowResetEdge(line({ state: "exhausted" }), line({ state: "exhausted", observedAt: T0 + i * 1000 }), "test")).toBeUndefined();
    }
  });

  test("an edge forwards the complete observed identity without inferring scope", () => {
    for (const scope of ["account", "model", "org", "unknown"] as const) {
      const identity = { scope, model: "model-a", orgFingerprint: "org:one" };
      expect(windowResetEdge(line({ ...identity, state: "exhausted" }), line(identity), "test")).toEqual({
        kind: "window-reset", at: T0, source: "test", provider: "anthropic",
        accountFingerprint: "a:1111aaaa2222", ...identity,
        detail: "usage window reopened (observed via status:200)",
      });
    }
  });

  test("different provider, account, scope, model or organization never produces a reset", () => {
    const before = line({ state: "exhausted", scope: "model", model: "model-a", orgFingerprint: "org:one" });
    for (const mismatch of [
      { provider: "openai" }, { account: "a:other" }, { scope: "account" as const },
      { scope: "unknown" as const }, { model: "model-b" }, { model: undefined },
      { orgFingerprint: "org:two" }, { orgFingerprint: undefined },
    ]) {
      expect(windowResetEdge(before, { ...before, state: "open", ...mismatch }, "test")).toBeUndefined();
    }
  });
});

// ─── the journal ────────────────────────────────────────────────────────────────────────────

const signal = (over: Partial<CapacitySignal> = {}): CapacitySignal =>
  ({ kind: "window-reset", at: T0, source: "test", provider: "anthropic", accountFingerprint: "a:1111aaaa2222", ...over });

describe("CapacityJournal", () => {
  test("appends complete newline-terminated lines with a monotonic seq", () => {
    const j = new CapacityJournal(journalPath);
    expect(j.append(signal())!.seq).toBe(1);
    expect(j.append(signal({ at: T0 + 1 }))!.seq).toBe(2);
    const text = readFileSync(journalPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  test("a reopened journal continues the sequence rather than restarting at 1", () => {
    new CapacityJournal(journalPath).append(signal());
    expect(new CapacityJournal(journalPath).append(signal())!.seq).toBe(2);
  });

  test("a trailing fragment without a newline is NOT an event and does not advance the offset", () => {
    const j = new CapacityJournal(journalPath);
    j.append(signal());
    const afterFirst = j.readFrom(0);
    expect(afterFirst.lines).toHaveLength(1);
    appendFileSync(journalPath, '{"v":1,"seq":2,"at":1,"pid":1,"signal":{"kind":"wi');
    const torn = j.readFrom(afterFirst.offset);
    expect(torn.lines).toEqual([]);
    expect(torn.offset).toBe(afterFirst.offset);
  });

  test("a torn line becomes readable once its newline arrives", () => {
    const j = new CapacityJournal(journalPath);
    const whole = JSON.stringify({ v: CAPACITY_WIRE_VERSION, seq: 1, at: T0, pid: 1, signal: signal(), scope: "account" });
    appendFileSync(journalPath, whole.slice(0, 20));
    expect(j.readFrom(0).lines).toEqual([]);
    appendFileSync(journalPath, whole.slice(20) + "\n");
    expect(j.readFrom(0).lines).toHaveLength(1);
  });

  test("an unknown schema version is SKIPPED and counted, never thrown", () => {
    appendFileSync(journalPath, JSON.stringify({ v: 999, seq: 1, at: T0, pid: 1, signal: signal(), scope: "account" }) + "\n");
    const read = new CapacityJournal(journalPath).readFrom(0);
    expect(read.lines).toEqual([]);
    expect(read.skipped).toBe(1);
  });

  test("unparseable and malformed lines are skipped without losing the good ones around them", () => {
    const j = new CapacityJournal(journalPath);
    j.append(signal());
    appendFileSync(journalPath, "{not json at all\n");
    appendFileSync(journalPath, JSON.stringify({ v: 1, seq: 3, signal: { kind: "nonsense" } }) + "\n");
    j.append(signal({ at: T0 + 5 }));
    const read = j.readFrom(0);
    expect(read.lines).toHaveLength(2);
    expect(read.skipped).toBe(2);
  });

  test("a truncated or replaced file restarts from the beginning instead of reading mid-line", () => {
    const j = new CapacityJournal(journalPath);
    j.append(signal());
    j.append(signal({ at: T0 + 1 }));
    const first = j.readFrom(0);
    writeFileSync(journalPath, "");
    const after = j.readFrom(first.offset);
    expect(after.offset).toBe(0);
    expect(after.lines).toEqual([]);
  });

  test("a credential-shaped signal is refused at the write boundary and never reaches disk", () => {
    const j = new CapacityJournal(journalPath);
    const written = j.append(signal({ detail: "upstream said sk-ant-api03-AAAAAAAAAAAAAAAAAAAA" }));
    expect(written).toBeUndefined();
    let text = "";
    try { text = readFileSync(journalPath, "utf8"); } catch { text = ""; }
    expect(text).not.toContain("sk-ant-api03");
  });

  test("append carries identity inside the signal and mirrors its scope outside", () => {
    const j = new CapacityJournal(journalPath);
    const original = signal({ scope: "model", model: "model-a", orgFingerprint: "org:one" });
    expect(j.append(original)!.signal).toEqual(original);
    expect(j.readFrom(0).lines[0]).toMatchObject({ scope: "model", signal: original });
  });

  test("legacy outer scope backfills only a missing inner claim", () => {
    const j = new CapacityJournal(journalPath);
    for (const inner of [undefined, "unknown", "model"] as const) {
      appendFileSync(journalPath, JSON.stringify({ v: 1, seq: 1, at: T0, pid: 1,
        signal: signal({ scope: inner, model: "model-a" }), scope: "account" }) + "\n");
    }
    const lines = j.readFrom(0).lines;
    expect(lines.map(l => l.signal.scope)).toEqual(["account", "unknown", "unknown"]);
    expect(lines.map(l => l.scope)).toEqual(["account", "unknown", "unknown"]);
    expect(lines.every(l => l.signal.model === "model-a")).toBe(true);
  });

  test("append never widens explicit unknown or contradictory scope", () => {
    const j = new CapacityJournal(journalPath);
    expect(j.append(signal(), "account")!.signal.scope).toBe("account");
    expect(j.append(signal({ scope: "unknown" }), "account")!.signal.scope).toBe("unknown");
    expect(j.append(signal({ scope: "model" }), "account")!.signal.scope).toBe("unknown");
    expect(j.append(signal())!.signal.scope).toBe("unknown");
  });
});

// ─── the producer ───────────────────────────────────────────────────────────────────────────

describe("recordCapacity — real observations only", () => {
  const state = () => createProducerState(journalPath, snapshotPath);

  test("a 429 records exhaustion as level state and emits NO signal (a refusal is not a recovery)", () => {
    const ctx = state();
    const written = recordCapacity({ provider: "anthropic", at: T0, account: "a:1111", status: 429, headers: { "retry-after": "600" } }, ctx);
    expect(written).toEqual([]);
    const snap = readCapacitySnapshot(snapshotPath)!;
    const rec = snap.lines[lineKey("anthropic", "a:1111")];
    expect(rec.state).toBe("exhausted");
    expect(rec.resetsAt).toBe(T0 + 600_000);
  });

  test("429 then an accepted 200 emits exactly one window-reset", () => {
    const ctx = state();
    recordCapacity({ provider: "anthropic", at: T0, account: "a:1111", status: 429, headers: { "retry-after": "600" } }, ctx);
    const written = recordCapacity({ provider: "anthropic", at: T0 + 600_001, account: "a:1111", status: 200 }, ctx);
    expect(written).toHaveLength(1);
    expect(written[0].signal).toMatchObject({ kind: "window-reset", provider: "anthropic", accountFingerprint: "a:1111" });
  });

  test("repeated 429s on the same line emit nothing at all — no per-request event storm", () => {
    const ctx = state();
    for (let i = 0; i < 200; i++) {
      expect(recordCapacity({ provider: "anthropic", at: T0 + i * 100, account: "a:1111", status: 429 }, ctx)).toEqual([]);
    }
  });

  test("two accounts of one provider live at once never diff against each other", () => {
    const ctx = state();
    recordCapacity({ provider: "anthropic", at: T0, account: "a:AAAA", status: 429 }, ctx);
    // A different account of the same provider is a different line, not a switch back and forth.
    expect(recordCapacity({ provider: "anthropic", at: T0 + 1, account: "a:BBBB", status: 200 }, ctx)).toEqual([]);
    expect(recordCapacity({ provider: "anthropic", at: T0 + 2, account: "a:AAAA", status: 429 }, ctx)).toEqual([]);
    expect(recordCapacity({ provider: "anthropic", at: T0 + 3, account: "a:BBBB", status: 200 }, ctx)).toEqual([]);
  });

  test("a billing refusal records exhaustion with NO reset instant — no clock can clear it", () => {
    const ctx = state();
    recordCapacity({ provider: "anthropic", at: T0, account: "a:1111", status: 402 }, ctx);
    const rec = readCapacitySnapshot(snapshotPath)!.lines[lineKey("anthropic", "a:1111")];
    expect(rec.state).toBe("exhausted");
    expect(rec.resetsAt).toBeUndefined();
  });

  test("scope survives inside the signal as well as onto the outer wire line", () => {
    const ctx = state();
    recordCapacity({ provider: "anthropic", at: T0, account: "a:1111", status: 429, scope: "model" }, ctx);
    const written = recordCapacity({ provider: "anthropic", at: T0 + 1000, account: "a:1111", status: 200, scope: "model" }, ctx);
    expect(written[0].scope).toBe("model");
    expect(written[0].signal.scope).toBe("model");
  });

  test("the snapshot is rewritten on every observation, including ones that emit nothing", () => {
    const ctx = state();
    recordCapacity({ provider: "openai", at: T0, account: "o:1", status: 429 }, ctx);
    const first = readCapacitySnapshot(snapshotPath)!;
    recordCapacity({ provider: "openai", at: T0 + 5000, account: "o:1", status: 429 }, ctx);
    const second = readCapacitySnapshot(snapshotPath)!;
    expect(second.lines[lineKey("openai", "o:1")].observedAt).toBe(T0 + 5000);
    expect(second.writtenAt).toBeGreaterThan(first.writtenAt - 1);
  });

  test("a restarted producer resumes from the snapshot instead of treating the world as new", () => {
    recordCapacity({ provider: "anthropic", at: T0, account: "a:1111", status: 429 }, state());
    // A brand-new producer object, as after a process restart.
    const written = recordCapacity({ provider: "anthropic", at: T0 + 600_001, account: "a:1111", status: 200 }, state());
    expect(written).toHaveLength(1);
    expect(written[0].signal.kind).toBe("window-reset");
  });

  test("observed request model does not imply model or account capacity scope", () => {
    const ctx = state();
    const input = { provider: "anthropic", account: "a:1", model: "model-a" };
    recordCapacity({ ...input, at: T0, status: 429 }, ctx);
    const [written] = recordCapacity({ ...input, at: T0 + 1, status: 200 }, ctx);
    expect(written.signal).toMatchObject({ scope: "unknown", model: "model-a" });
    expect(written.scope).toBe("unknown");
    expect(readCapacitySnapshot(snapshotPath)!.lines[lineKey("anthropic", "a:1", "unknown", "model-a")].scope).toBe("unknown");
  });

  test("concurrent model, scope and organization lines remain independent across restart", () => {
    const ctx = state();
    const base = { provider: "anthropic", account: "a:1", scope: "model" as const, model: "model-a", orgFingerprint: "org:one" };
    const identities = [base, { ...base, model: "model-b" }, { ...base, scope: "account" as const },
      { ...base, scope: "unknown" as const }, { ...base, orgFingerprint: "org:two" }];
    identities.forEach((identity, i) => {
      expect(recordCapacity({ ...identity, at: T0 + i, status: 429 }, ctx)).toEqual([]);
    });
    const restarted = state();
    identities.forEach((identity, i) => {
      const [event] = recordCapacity({ ...identity, at: T0 + 100 + i, status: 200 }, restarted);
      expect(event.signal).toMatchObject({ scope: identity.scope, model: identity.model, orgFingerprint: identity.orgFingerprint });
    });
    expect(Object.keys(readCapacitySnapshot(snapshotPath)!.lines)).toHaveLength(identities.length);
  });

  test("an unrelated model cannot clear or replace the exhausted model baseline", () => {
    const ctx = state();
    const base = { provider: "anthropic", account: "a:1", scope: "model" as const };
    recordCapacity({ ...base, model: "model-a", at: T0, status: 429 }, ctx);
    expect(recordCapacity({ ...base, model: "model-b", at: T0 + 1, status: 200 }, ctx)).toEqual([]);
    expect(readCapacitySnapshot(snapshotPath)!.lines[lineKey(base.provider, base.account, base.scope, "model-a")].state).toBe("exhausted");
    expect(recordCapacity({ ...base, model: "model-a", at: T0 + 2, status: 200 }, ctx)).toHaveLength(1);
  });

  test("legacy provider/account snapshots stay held and cannot seed a scoped reset", () => {
    const legacy = line({ state: "exhausted", model: "model-a", orgFingerprint: "org:one" });
    const key = `${legacy.provider}|${legacy.account}`;
    writeFileSync(snapshotPath, JSON.stringify({ v: 1, writtenAt: T0, pid: 1, lines: { [key]: legacy } }));
    expect(readCapacitySnapshot(snapshotPath)!.lines[key]).toEqual({ ...legacy, scope: "unknown", state: "unknown" });
    expect(recordCapacity({ ...legacy, at: T0 + 1, status: 200 }, state())).toEqual([]);
    const saved = readCapacitySnapshot(snapshotPath)!;
    expect(saved.lines[key]).toEqual({ ...legacy, scope: "unknown", state: "unknown" });
    expect(Object.keys(saved.lines)).toHaveLength(2);
  });

  test("identity tuple keys cannot collide on delimiter-containing models or organizations", () => {
    expect(lineKey("p", "a", "model", "m|org:o", "x")).not.toBe(lineKey("p", "a", "model", "m", "org:o|x"));
    expect(lineKey("p", "a", "unknown", "m")).not.toBe(lineKey("p", "a", "model", "m"));
  });
});

// ─── the feed ───────────────────────────────────────────────────────────────────────────────

describe("createCapacityFeed — nothing is invented", () => {
  const feedOpts = () => ({ outcomes, snapshot: snapshotPath, journal: journalPath, outcomesRecheckMs: 0, journalPollMs: 0 });

  test("constructing a feed reads nothing and starts nothing", () => {
    const feed = createCapacityFeed(feedOpts());
    expect(feed.stats()).toMatchObject({ accountChanges: 0, windowResets: 0, outcomeReads: 0, snapshotReads: 0 });
    feed.close();
  });

  test("an empty world produces no signals, ever — there is no timer that emits", async () => {
    writeOutcomes({ anthropic: entry("aaa") });
    const seen: CapacitySignal[] = [];
    const feed = createCapacityFeed(feedOpts());
    const stop = feed.subscribe(s => seen.push(s));
    await new Promise(r => setTimeout(r, 120));
    expect(seen).toEqual([]);
    stop();
    feed.close();
  });

  test("subscribing seeds the baseline without replaying the existing world as news", () => {
    writeOutcomes({ anthropic: entry("aaa"), google: entry("g:bbb") });
    writeFileSync(snapshotPath, JSON.stringify({
      v: CAPACITY_WIRE_VERSION, writtenAt: Date.now(), pid: 1,
      lines: { [lineKey("anthropic", "a:1")]: line({ state: "open", observedAt: Date.now() }) },
    }));
    const seen: CapacitySignal[] = [];
    const feed = createCapacityFeed(feedOpts());
    const stop = feed.subscribe(s => seen.push(s));
    expect(seen).toEqual([]);
    stop();
    feed.close();
  });

  test("stats show the sources were actually read — a silent feed is not a dead one", () => {
    writeOutcomes({ anthropic: entry("aaa") });
    const feed = createCapacityFeed(feedOpts());
    const stop = feed.subscribe(() => {});
    expect(feed.stats().outcomeReads).toBeGreaterThan(0);
    stop();
    feed.close();
  });
});

describe("probe — the last barrier before a run burns its resume", () => {
  const feedOpts = () => ({ outcomes, snapshot: snapshotPath, journal: journalPath, outcomesRecheckMs: 0, journalPollMs: 0 });

  const writeSnapshot = (lines: Record<string, CapacitySnapshotEntry>) =>
    writeFileSync(snapshotPath, JSON.stringify({ v: CAPACITY_WIRE_VERSION, writtenAt: Date.now(), pid: 1, lines }));

  test("a line still recorded exhausted answers a definite NO", async () => {
    const now = Date.now();
    writeSnapshot({ [lineKey("anthropic", "a:1", "account")]: line({ account: "a:1", state: "exhausted", observedAt: now, resetsAt: now + 60_000 }) });
    const feed = createCapacityFeed(feedOpts());
    const probe = await feed.probe({ provider: "anthropic", accountFingerprint: "a:1", scope: "account", at: now });
    expect(probe.available).toBe(false);
    feed.close();
  });

  test("a line freshly observed open answers YES", async () => {
    const now = Date.now();
    writeSnapshot({ [lineKey("anthropic", "a:1", "account")]: line({ account: "a:1", state: "open", observedAt: now }) });
    const feed = createCapacityFeed(feedOpts());
    expect((await feed.probe({ provider: "anthropic", accountFingerprint: "a:1", scope: "account", at: now })).available).toBe(true);
    feed.close();
  });

  test("a stale reading demotes to unknown rather than vouching for itself", async () => {
    const now = Date.now();
    writeSnapshot({ [lineKey("anthropic", "a:1", "account")]: line({ account: "a:1", state: "open", observedAt: now - SNAPSHOT_STALE_MS - 1000 }) });
    const feed = createCapacityFeed(feedOpts());
    expect((await feed.probe({ provider: "anthropic", accountFingerprint: "a:1", scope: "account", at: now })).available).toBe("unknown");
    feed.close();
  });

  test("with nothing recorded the answer is UNKNOWN — never a cheerful true", async () => {
    const feed = createCapacityFeed(feedOpts());
    const probe = await feed.probe({ provider: "anthropic", accountFingerprint: "a:1", at: Date.now() });
    expect(probe.available).toBe("unknown");
    expect(probe.available).not.toBe(true);
    feed.close();
  });

  test("an identity that has moved on since the signal answers NO", async () => {
    writeOutcomes({ anthropic: entry("now-a-different-chain") });
    const feed = createCapacityFeed(feedOpts());
    const probe = await feed.probe({ provider: "anthropic", accountFingerprint: "the-old-chain", at: Date.now() });
    expect(probe.available).toBe(false);
    feed.close();
  });

  test("probe never throws, even against a corrupt snapshot", async () => {
    writeFileSync(snapshotPath, "{{{ not json");
    const feed = createCapacityFeed(feedOpts());
    expect((await feed.probe({ provider: "anthropic", at: Date.now() })).available).toBe("unknown");
    feed.close();
  });

  test("probe never borrows capacity from another identity or an unknown scope", async () => {
    const now = Date.now();
    const identity = { provider: "anthropic", accountFingerprint: "a:1", scope: "model" as const, model: "model-a", orgFingerprint: "org:one", at: now };
    writeSnapshot({ [lineKey(identity.provider, identity.accountFingerprint, identity.scope, identity.model, identity.orgFingerprint)]:
      line({ account: "a:1", scope: "model", model: "model-a", orgFingerprint: "org:one", observedAt: now }) });
    const feed = createCapacityFeed(feedOpts());
    expect((await feed.probe(identity)).available).toBe(true);
    for (const change of [{ model: "model-b" }, { model: undefined }, { orgFingerprint: "org:two" },
      { accountFingerprint: "a:2" }, { scope: "unknown" as const }, { scope: undefined }]) {
      expect((await feed.probe({ ...identity, ...change })).available).toBe("unknown");
    }
    feed.close();
  });
});

// ─── the anti-theatre assertions ────────────────────────────────────────────────────────────

describe("this producer cannot fake capacity", () => {
  test("no code path in the module emits a `manual` signal — manual is the human's escape hatch alone", () => {
    const source = readFileSync(new URL("../src/capacity-events.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/kind:\s*["']manual["']/);
  });

  test("no interval or timeout drives emission independently of an observation", () => {
    const source = readFileSync(new URL("../src/capacity-events.ts", import.meta.url), "utf8");
    // The only timers are the re-read backstops, which call the pump functions; a pump that finds no
    // change emits nothing. Assert no timer is wired straight to a listener call.
    expect(source).not.toMatch(/setInterval\([^)]*listener/);
    expect(source).not.toMatch(/setTimeout\([^)]*listener/);
  });

  test("the module never reads a credential well", () => {
    const source = readFileSync(new URL("../src/capacity-events.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".credentials.json");
    expect(source).not.toContain("auth.json");
    expect(source).not.toMatch(/\bkeychain\b/i);
    expect(source).not.toMatch(/refreshCreds|prepare\(|\.creds\(/);
  });

  test("the module never writes the outcomes ledger it observes", () => {
    const source = readFileSync(new URL("../src/capacity-events.ts", import.meta.url), "utf8");
    const writesToOutcomes = /write[^\n]*outcomesPath|outcomesPath[^\n]*write/i;
    expect(source).not.toMatch(writesToOutcomes);
  });
});
