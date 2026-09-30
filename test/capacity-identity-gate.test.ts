/**
 * capacity-identity-gate.test.ts — the two failure modes that let apiplan's capacity pipeline lie.
 *
 * 1. IDENTITY. `credFp()` does not report an unreadable credential well as an absent field: it returns
 *    a placeholder in the SAME string a real fingerprint uses — `"absent"` (`src/providers.ts:593`,
 *    `:799`, `:1624`), `"unusable:<state>"` (`src/providers.ts:1622`) — and `credOf()` returns `""` on
 *    a throw and a provider's human-readable PROBE LINE for a provider with no credential at all
 *    (`src/api.ts:200`, `:204`). `noteCall()` writes whatever it got verbatim into `outcomes.json`
 *    (`src/api.ts:265`). Admitting any of those as an account breaks capacity in both directions, and
 *    each direction is asserted here.
 *
 * 2. STREAM LIFETIME. A streaming answer keeps pumping upstream after `serve()`'s handler has already
 *    returned, so counting only the handler reports zero in flight during exactly the long-lived case.
 *    `hotswap upgrade` reads that zero as "safe to SIGTERM" (`bin/apiplan.ts:683-688`) and `serve()`
 *    installs no signal handler, so the kill lands mid-turn. The drain gate is only honest if a
 *    streaming request stays counted until its BODY finishes.
 *
 * The stream half runs a real `serve()` on a loopback port against a real loopback provider endpoint;
 * no module is mocked and no vendor is reached. The identity half is pure.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRealAccountIdent } from "../src/capacity-signal.ts";
import {
  capacityJournalPath, capacitySnapshotPath, createProducerState, identsFromOutcomes,
  lineKey, outcomesPath, readCapacitySnapshot, recordCapacity,
} from "../src/capacity-events.ts";

describe("only a credential-backed account is an account identity", () => {
  // Every non-identity the real credential readers can actually put in this field, cited at source.
  test("rejects every placeholder and every no-account probe line", () => {
    for (const rejected of [
      "absent",                 // providers.ts:593 (anthropic), :799 (codex), :1624 (google, no access token)
      "unusable:absent",        // providers.ts:1622 with GoogleRead state "absent"
      "unusable:unreadable",    // providers.ts:1622 with GoogleRead state "unreadable"
      "",                       // api.ts:204, credOf() caught a throw
      "   ",
      "unknown",
      "UNUSABLE:ABSENT",        // case must not be an escape hatch
      "unusable:some-future-state-nobody-has-written-yet",
      // api.ts:200 — the probe-line fallback for a provider with NO credential. This is the exact
      // live value in ~/.apiplan/outcomes.json for ollama. Stable, so it fabricates no account
      // change, but it is a service description: it moves with the local port/version, and a local
      // model server has no quota window to reopen. Unknown, not an account.
      "http://127.0.0.1:11434 · ollama 0.33.0 · no account, no token, no quota",
      "http://127.0.0.1:11434",
      "some human readable detail",
    ]) expect(isRealAccountIdent(rejected)).toBe(false);
    expect(isRealAccountIdent(undefined)).toBe(false);
  });

  // Fails closed on vocabulary, not on a digest whitelist: a whitelist would reject a legitimately
  // new identity shape, and Google's ident is already not a digest (providers.ts:1626).
  test("accepts every real identity shape the providers actually produce", () => {
    for (const real of [
      "a64c5ea24f85",            // anthropic: h12(refreshToken), providers.ts:596 — live value today
      "b6e038098879",            // codex: h12(refresh_token|account_id), providers.ts:801 — live value today
      "g:f10a9466039c",          // google via fingerprintAccount, capacity-signal.ts:114 — live value today
      "a:1111aaaa2222",
      "google-account-id-0123",  // google may return the plain account id, providers.ts:1626
    ]) expect(isRealAccountIdent(real)).toBe(true);
  });

  test("the outcomes parser keeps real chains and omits everything else", () => {
    // Shaped exactly like the real ~/.apiplan/outcomes.json read at 2026-09-06T09:44Z.
    const idents = identsFromOutcomes({
      anthropic: { ok: true, at: 1, ident: "a64c5ea24f85", cred: "hash:1", exp: 0 },
      openai: { ok: false, at: 2, ident: "absent", cred: "absent", exp: 0 },
      google: { ok: false, at: 3, ident: "unusable:unreadable", cred: "unusable:unreadable", exp: 0 },
      ollama: { ok: true, at: 4, ident: "http://127.0.0.1:11434 · ollama 0.33.0 · no account, no token, no quota", cred: "x", exp: 0 },
      broken: { ok: true, at: 5, ident: "", cred: "", exp: 0 },
      absentee: { ok: true, at: 6, cred: "x", exp: 0 },
    });
    expect([...idents.keys()]).toEqual(["anthropic"]);
    expect(idents.get("anthropic")).toBe("a64c5ea24f85");
  });
});

describe("the producer refuses to build capacity state on a non-identity", () => {
  const dirs: string[] = [];
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-ident-gate-"));
    dirs.push(dir);
    return { snapshot: join(dir, "capacity-state.json"), journal: join(dir, "capacity-events.jsonl"), outcomes: join(dir, "outcomes.json") };
  };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const T = 1_700_000_000_000;

  // DIRECTION A — the fabricated reset. Both observations carry the placeholder, so if one ever
  // reaches the producer they share a single snapshot line and the second reads as "window reopened".
  test("two unreadable-well observations would otherwise mint a window-reset out of nothing", () => {
    const paths = fixture();
    const ctx = createProducerState(paths.journal, paths.snapshot);
    // The damage, pinned rather than described: this is what the pipeline does if a placeholder is
    // ever admitted as an account.
    recordCapacity({ provider: "anthropic", account: "absent", model: "claude-opus-5", at: T, status: 429 }, ctx);
    const reopened = recordCapacity({ provider: "anthropic", account: "absent", model: "claude-opus-5", at: T + 1000, status: 200 }, ctx);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.signal.kind).toBe("window-reset");
    expect(reopened[0]?.signal.accountFingerprint).toBe("absent");

    // The gate is at the hook sites, so no such line is ever created: `src/api.ts:429-433` and
    // `src/engine.ts:620-624` resolve a non-identity to `undefined` and skip the call entirely.
    const gatedPaths = fixture();
    const gated = createProducerState(gatedPaths.journal, gatedPaths.snapshot);
    for (const ident of ["absent", "unusable:unreadable", "", "http://127.0.0.1:11434 · no account, no token, no quota"]) {
      expect(isRealAccountIdent(ident) ? ident : undefined).toBeUndefined();
    }
    expect(Object.keys(gated.snapshot.lines)).toEqual([]);
    expect(readCapacitySnapshot(gatedPaths.snapshot)).toBeUndefined();
  });

  // DIRECTION B — the LOST switch, the worse one: the human's own stated recovery path is a new
  // account, and a placeholder makes two genuinely different accounts compare equal.
  test("a real account switch straddling a read failure is not erased by the placeholder", () => {
    const paths = fixture();
    // A → (well unreadable) → B, as `outcomes.json` holds it at each step.
    const steps = [
      { anthropic: { ok: true, at: 1, ident: "a64c5ea24f85" } },
      { anthropic: { ok: false, at: 2, ident: "unusable:unreadable" } },
      { anthropic: { ok: true, at: 3, ident: "bbbbbbbbbbbb" } },
    ];
    const seen: string[] = [];
    for (const step of steps) {
      writeFileSync(paths.outcomes, JSON.stringify(step));
      const ident = identsFromOutcomes(JSON.parse(readFileSync(paths.outcomes, "utf8"))).get("anthropic");
      if (ident !== undefined) seen.push(ident);
    }
    // The gap contributes NOTHING, so the two real identities stay adjacent and compare unequal —
    // which is what lets the diff report exactly one A→B change instead of losing it.
    expect(seen).toEqual(["a64c5ea24f85", "bbbbbbbbbbbb"]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("a real identity still records and still reopens, so the gate did not disable the feature", () => {
    const paths = fixture();
    const ctx = createProducerState(paths.journal, paths.snapshot);
    const account = "a64c5ea24f85";
    expect(isRealAccountIdent(account)).toBe(true);
    expect(recordCapacity({ provider: "anthropic", account, model: "claude-opus-5", at: T, status: 429, headers: { "retry-after": "600" } }, ctx)).toEqual([]);
    const key = lineKey("anthropic", account, "unknown", "claude-opus-5", undefined);
    expect(readCapacitySnapshot(paths.snapshot)?.lines[key]).toMatchObject({ state: "exhausted", resetsAt: T + 600_000 });
    const written = recordCapacity({ provider: "anthropic", account, model: "claude-opus-5", at: T + 600_001, status: 200 }, ctx);
    expect(written).toHaveLength(1);
    expect(written[0]?.signal).toMatchObject({ kind: "window-reset", provider: "anthropic", accountFingerprint: account });
  });

  // The isolated-verification recipe depends on this: a test instance must be able to point its own
  // capacity state somewhere that cannot touch the live server's files.
  test("the state paths stay inside APIPLAN_HOME and are overridable per instance", () => {
    const home = process.env.APIPLAN_HOME || join(homedir(), ".apiplan");
    expect(capacitySnapshotPath()).toBe(process.env.APIPLAN_CAPACITY_STATE || join(home, "capacity-state.json"));
    expect(capacityJournalPath()).toBe(process.env.APIPLAN_CAPACITY_EVENTS || join(home, "capacity-events.jsonl"));
    expect(outcomesPath()).toBe(process.env.APIPLAN_OUTCOMES_FILE || join(home, "outcomes.json"));
  });
});

describe("the drain gate counts a streaming body, not just its handler", () => {
  // A real `serve()` and a real loopback provider. The provider holds its stream open on command, so
  // the assertion is made while a genuine SSE answer is mid-flight.
  const started: Array<() => void> = [];
  afterEach(() => { for (const stop of started.splice(0)) stop(); });

  const control = async (url: string) => await (await fetch(`${url}/_apiplan/control`)).json() as { activeRequests: number; completedRequests: number; accepting: boolean };

  test("activeRequests stays above zero until the SSE body completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-drain-gate-"));
    const credFile = join(dir, "anthropic.json");
    writeFileSync(credFile, JSON.stringify({
      claudeAiOauth: { accessToken: "AT-drain-gate-fixture", refreshToken: "RT-drain-gate-fixture", expiresAt: Date.now() + 6 * 3600_000 },
    }));

    // The provider releases its stream only when told to, so "mid-flight" is deterministic rather
    // than a sleep race.
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let sawRequest!: () => void;
    const requestSeen = new Promise<void>(resolve => { sawRequest = resolve; });
    const frames = [
      { type: "message_start", message: { id: "fx", type: "message", role: "assistant", model: "claude-opus-5", content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "held" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    const provider = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/tags") return Response.json({ models: [] });
        if (path !== "/v1/messages") return new Response("unexpected", { status: 404 });
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            const enc = new TextEncoder();
            // One frame, then hold: the upstream stream is open and the answer is incomplete.
            c.enqueue(enc.encode(frames[0]!));
            sawRequest();
            await released;
            for (const frame of frames.slice(1)) c.enqueue(enc.encode(frame));
            c.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    const previous: Record<string, string | undefined> = {
      APIPLAN_HOME: process.env.APIPLAN_HOME,
      APIPLAN_ANTHROPIC_CRED_FILE: process.env.APIPLAN_ANTHROPIC_CRED_FILE,
      APIPLAN_ANTHROPIC_BASE: process.env.APIPLAN_ANTHROPIC_BASE,
      APIPLAN_OLLAMA_BASE: process.env.APIPLAN_OLLAMA_BASE,
      APIPLAN_CAPACITY_STATE: process.env.APIPLAN_CAPACITY_STATE,
      APIPLAN_CAPACITY_EVENTS: process.env.APIPLAN_CAPACITY_EVENTS,
    };
    process.env.APIPLAN_HOME = dir;
    process.env.APIPLAN_ANTHROPIC_CRED_FILE = credFile;
    process.env.APIPLAN_ANTHROPIC_BASE = `http://127.0.0.1:${provider.port}`;
    process.env.APIPLAN_OLLAMA_BASE = `http://127.0.0.1:${provider.port}`;
    process.env.APIPLAN_CAPACITY_STATE = join(dir, "capacity-state.json");
    process.env.APIPLAN_CAPACITY_EVENTS = join(dir, "capacity-events.jsonl");

    try {
      const { serve } = await import("../src/api.ts");
      const server = serve({ port: 0, host: "127.0.0.1", token: "" });
      started.push(server.stop);

      const answer = fetch(`${server.url}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5", stream: true, messages: [{ role: "user", content: "hold the stream" }], max_tokens: 32 }),
      });

      await requestSeen;
      // The client has its Response and the handler returned long ago, but the body is still being
      // produced. THIS is the reading `hotswap upgrade` polls, and the whole bug was that it said 0.
      const midFlight = await control(server.url);
      expect(midFlight.activeRequests).toBeGreaterThan(0);
      expect(midFlight.completedRequests).toBe(0);

      release();
      expect(await (await answer).text()).toContain("message_stop");

      // The settle callback runs a turn after the last chunk; wait for it rather than racing it.
      for (let i = 0; i < 200 && (await control(server.url)).activeRequests > 0; i++) await Bun.sleep(10);
      const finished = await control(server.url);
      expect(finished.activeRequests).toBe(0);
      expect(finished.completedRequests).toBeGreaterThan(0);
      expect(finished.accepting).toBe(true);
    } finally {
      release();
      provider.stop(true);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a non-streaming request is released by its handler, exactly as before", async () => {
    const { serve } = await import("../src/api.ts");
    const server = serve({ port: 0, host: "127.0.0.1", token: "" });
    started.push(server.stop);
    expect((await fetch(`${server.url}/v1/models`)).status).toBe(200);
    const after = await control(server.url);
    expect(after.activeRequests).toBe(0);
    expect(after.completedRequests).toBeGreaterThan(0);
  });
});
