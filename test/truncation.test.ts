// The end-of-turn check, on the three readers that share it.
//
// A stream that stops before the vendor's own end-of-turn event is an INCOMPLETE answer,
// and the fault only stays fixed if every reader asks the same question: the server's
// run() learned it first, and while the CLI's consume() and the chat's streamReply() had
// not, `sol "…"` still printed half an answer and exited 0. These tests hold all three to
// the one shared watch, and hold the retry budget that keeps the error from taking minutes
// to appear.
import { expect, test, describe } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { watchTerminal, truncatedMessage, UPSTREAM_TRUNCATED } from "../src/stream-shape.ts";
import { anthropic, openai, google } from "../src/providers.ts";
import { ollama } from "../src/providers-ollama.ts";

const ROOT = join(import.meta.dir, "..");
const src = (f: string) => readFileSync(join(ROOT, "src", f), "utf8");

describe("watchTerminal — the shared end-of-turn watch", () => {
  test("a stream that never terminates is missing()", () => {
    const w = watchTerminal(anthropic);
    w.see({ type: "message_start" });
    w.see({ type: "content_block_delta", delta: { type: "text_delta", text: "half" } });
    expect(w.missing()).toBe(true);
  });

  test("a stream that terminates is not", () => {
    const w = watchTerminal(anthropic);
    w.see({ type: "content_block_delta" });
    w.see({ type: "message_stop" });
    expect(w.missing()).toBe(false);
  });

  test("a ZERO-event stream is missing() — the cut that used to print nothing at all", () => {
    expect(watchTerminal(anthropic).missing()).toBe(true);
  });

  test("every vendor here answers the question", () => {
    expect(watchTerminal(openai).missing()).toBe(true);
    expect(watchTerminal(google).missing()).toBe(true);
    expect(watchTerminal(ollama).missing()).toBe(true);
    for (const [p, ev] of [
      [openai, { type: "response.completed" }],
      [google, { response: { candidates: [{ finishReason: "STOP" }] } }],
      [ollama, { done: true }],
    ] as const) {
      const w = watchTerminal(p as any);
      w.see(ev);
      expect(w.missing()).toBe(false);
    }
  });

  test("a terminal() that throws is not allowed to break the read", () => {
    const boom = { ...anthropic, terminal: () => { throw new Error("nope"); } } as any;
    const w = watchTerminal(boom);
    expect(() => w.see({ any: "thing" })).not.toThrow();
    expect(w.missing()).toBe(true);
  });

  test("APIPLAN_TRUNCATION_CHECK=0 is the field off-switch", () => {
    const prev = process.env.APIPLAN_TRUNCATION_CHECK;
    process.env.APIPLAN_TRUNCATION_CHECK = "0";
    try { expect(watchTerminal(anthropic).missing()).toBe(false); }
    finally { prev === undefined ? delete process.env.APIPLAN_TRUNCATION_CHECK : (process.env.APIPLAN_TRUNCATION_CHECK = prev); }
  });

  test("one message, so all three readers say the same thing", () => {
    expect(truncatedMessage(anthropic)).toContain(anthropic.label);
    expect(truncatedMessage(anthropic)).toContain("INCOMPLETE");
  });
});

describe("all three readers actually ask", () => {
  test("the server's run() uses the shared watch, not a private copy", () => {
    const s = src("api.ts");
    expect(s).toContain("watchTerminal");
    expect(s).toContain("term.see(ev)");
    expect(s).toContain("term.missing()");
    expect(s).not.toContain("let sawTerminal");     // the second copy is gone
  });

  test("the CLI's consume() asks — and exits NONZERO when the answer is short", () => {
    const s = src("engine.ts");
    const fn = s.slice(s.indexOf("export async function consume"), s.indexOf("function surface("));
    expect(fn).toContain("watchTerminal(p)");
    expect(fn).toContain("term.see(ev)");
    expect(fn).toContain("term.missing()");
    expect(fn).toContain("die(");                    // never a silent exit 0
  });

  test("a truncated CLI answer is NOT printed to stdout as if it were whole", () => {
    const s = src("engine.ts");
    const fn = s.slice(s.indexOf("export async function consume"), s.indexOf("function surface("));
    // the buffered branch prints only after the check, so the die() must come first
    expect(fn.indexOf("term.missing()")).toBeLessThan(fn.indexOf("else if (text) process.stdout.write"));
  });

  test("the chat's streamReply() throws rather than folding half a turn into history", () => {
    const s = src("engine.ts");
    const fn = s.slice(s.indexOf("export async function streamReply"), s.indexOf("export async function callDirect"));
    expect(fn).toContain("watchTerminal(p)");
    expect(fn).toContain("throw new Error(term.message())");
  });
});

describe("the retry budget — the error must land in seconds, not minutes", () => {
  const s = src("api.ts");

  test("the first cut in the window stays retryable (502)", () => {
    expect(s).toContain("if (n <= TRUNC_RETRYABLE) throw new HttpError(502");
  });

  test("a repeat cut is terminal, and says so in the one field a client reads", () => {
    expect(s).toContain("TRUNCATED_TERMINAL_STATUS = 424");
    expect(s).toContain('status === TRUNCATED_TERMINAL_STATUS ? "invalid_request_error"');
    expect(s).toContain('"x-should-retry": "false"');
  });

  test("a clean stream clears the streak, so one transient cut never spends the next one's budget", () => {
    expect(s).toContain("clearTruncations(m.provider)");
  });

  test("nothing else is made terminal — 429 and overloaded keep their own retry semantics", () => {
    expect(s).toContain('rate_limit_error: 429');
    expect(s).toContain('overloaded_error: 529');
    // the terminal status is reached ONLY from the truncation branch
    expect(s.match(/TRUNCATED_TERMINAL_STATUS,\n/g)?.length ?? 0).toBe(1);
  });

  test("the fault keeps its own name on the wire", () => {
    expect(UPSTREAM_TRUNCATED).toBe("upstream_truncated");
    expect(s).toContain("UPSTREAM_TRUNCATED);");
  });
});

describe("the rejection memory outlives the process", () => {
  const s = src("api.ts");

  test("outcomes are written to disk, atomically", () => {
    expect(s).toContain('OUTCOMES_FILE = join(STATE_DIR, "outcomes.json")');
    expect(s).toContain("writeJson(OUTCOMES_FILE");
    expect(s).toContain("saveOutcomes()");
  });

  test("and read back at startup — launchd restarts this service on its own", () => {
    expect(s).toContain("readJson<Record<string, Outcome>>(OUTCOMES_FILE");
  });

  test("a verdict is bound to the credential it was observed on, so a re-login clears it", () => {
    expect(s).toContain("const f = credOf(id);");
    expect(s).toContain("cred: f.cred");
    expect(s).toContain("o.cred !== f.cred");
  });

  // R-2 (round four, 2026-08-27): the TTL used to DELETE the entry, which turned a stored
  // rejection into "never-exercised" — and never-exercised read as green. Age must DEMOTE.
  test("and ages out — by demotion, never by deleting the evidence", () => {
    expect(s).toContain("OUTCOME_TTL_MS");
    expect(s).toContain("Date.now() - o.at > OUTCOME_TTL_MS");
    const fn = s.slice(s.indexOf("function verdictFor("), s.indexOf("const now = () =>"));
    expect(fn).toContain('return { state: "unverified", reason: "stale", prior }');
    expect(fn).not.toContain("OUTCOMES.delete(id)");
  });

  test("health reads the gated view, never the raw map", () => {
    const fn = s.slice(s.indexOf("function health()"), s.indexOf("/** Both vendors serve GET /v1/models"));
    expect(fn).toContain("verdictFor(id)");
    expect(fn).not.toContain("OUTCOMES.get(id)");
  });
});

// F6-1 (2026-08-27): the rejection memory was keyed on a credential fingerprint AND deleted
// the moment that fingerprint changed, so ANY refresh — agy, claude, the google heartbeat,
// the server's own self-refresh — erased the verdict and /health went green with no
// successful call ever observed. A refreshed-but-still-broken credential reported healthy.
describe("a refresh is not a pass", () => {
  const s = src("api.ts");
  const health = s.slice(s.indexOf("function health()"), s.indexOf("/** Both vendors serve GET /v1/models"));

  test("the verdict is three-state — ok / rejected / unverified — not a nullable outcome", () => {
    expect(s).toContain("function verdictFor(id: string): Verdict");
    expect(s).toContain('state: "unverified"; reason: "never-exercised" | "credential-changed" | "stale"');
  });

  test("a changed credential no longer DELETES the verdict — it demotes it to unverified and keeps the prior", () => {
    const fn = s.slice(s.indexOf("function verdictFor("), s.indexOf("const now = () =>"));
    expect(fn).toContain('return { state: "unverified", reason: "credential-changed"');
    expect(fn).toContain('const prior = { verdict: (o.ok ? "ok" : "rejected")');
    // NOTHING deletes a verdict any more: a credential change demotes it, and so does age
    // (R-2). The evidence a real call produced outlives both.
    expect(fn.match(/OUTCOMES\.delete\(id\)/g)?.length ?? 0).toBe(0);
  });

  test("a credential replaced AFTER a rejection is UNPROVEN, and unproven is never green", () => {
    // Broadened by R-2: ANY unverified state whose prior was a rejection is unproven — the
    // reason it went unverified (credential changed, or aged out) does not launder it.
    expect(health).toContain('v.state === "unverified" && v.prior?.verdict === "rejected"');
    expect(health).toContain("unprovenN === 0");
    // Round four widened this: unexercised and aged-out are their own honest state, and
    // neither of them is green. ok now costs an observed success on the credential in hand.
    expect(health).toContain('unprovenN ? "unproven" : unverifiedN ? "unverified" : "ok"');
    expect(health).toContain("unprovenN === 0 && unverifiedN === 0");
  });

  test("why it is unverified reaches the reader — reason and prior verdict are published", () => {
    expect(health).toContain("verified_reason: v.reason");
    expect(health).toContain("verified_prior:");
  });
});
