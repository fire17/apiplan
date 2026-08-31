// LM_GREET=announce — the mouth announces that it came up (canon 104).
//
// His order, call 25908, you-event t=1787444645847, byte-exact from the LOG:
//   "מגניב, בוא תוסיף בבקשה שהמוח יוסיף שהוא, זה טוב שהוא, ראיתי שהוא קרא על הפה בהתחלה,
//    אבל הפה לא קן אותי כשהוא עלה, אז גם כמובן הקונטקסט שלו צריך להמשיך מהסשן הקודם בלי
//    בעיות, אבל הוא כן צריך לבוא ולהעלות ולהגיד לי שהוא עלה."
//
// These are SOURCE-CONTRACT tests, the same shape as contract.test.ts: they read src/talk.ts
// as text and pin the mechanics that no unit test can reach without a live realtime socket
// (talk() loads OpenAI credentials from disk at src/talk.ts:93, before its injectable socket,
// so a fake-socket harness would need a credential bypass in the PRODUCTION path — see the
// build note; the seam was measured and declined, not forgotten).
//
// P10_TALK_SRC points the whole file at another copy — that is the SABOTAGE handle: copy
// talk.ts, delete one mechanic, re-run, watch the matching test go red. No test may be
// satisfiable by the checker itself.
import { expect, test, describe } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = process.env.P10_TALK_SRC
  || join(dirname(fileURLToPath(import.meta.url)), "..", "src", "talk.ts");
const src = readFileSync(SRC, "utf8");

/** The `case "session.updated":` handler body — where the opener is legally allowed to fire. */
const sessionUpdatedBlock = (() => {
  const a = src.indexOf('case "session.updated":');
  const b = src.indexOf('case "response.created":', a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
})();

describe("LM_GREET=announce — the mode", () => {
  test("announce is a recognised mode, and presence no longer swallows it", () => {
    expect(src).toContain('const GREET_ANNOUNCE = greetMode === "announce";');
    expect(src).toContain("const GREET_PRESENCE = !GREET_LEGACY && !GREET_OFF && !GREET_ANNOUNCE;");
  });
  test("presence is still the DEFAULT — announce is opt-in, never inherited", () => {
    expect(src).toContain('const greetMode = (process.env.LM_GREET ?? "presence")');
  });
  test("the connect say-info names the mode LOUDLY — P8 boot-proof waits on this exact string", () => {
    expect(src).toContain("GREET MODE: ANNOUNCE (${greetSrc})");
    expect(src).toContain('GREET_ANNOUNCE ? "announce"');
  });
  test("his words are in the file, verbatim", () => {
    expect(src).toContain("אבל הוא כן צריך לבוא ולהעלות ולהגיד לי שהוא עלה");
  });
});

describe("LM_GREET=announce — where it fires", () => {
  test("the opener fires from session.updated, never from onOpen (before the ack the persona is not live)", () => {
    expect(sessionUpdatedBlock).toContain("GREET_ANNOUNCE");
    expect(sessionUpdatedBlock).toContain("announceInstructions()");
    // onOpen's fresh path must not grow an announce emission of its own.
    const onOpen = src.slice(src.indexOf("const onOpen = () => {"), src.indexOf("async function micLoop()"));
    expect(onOpen).not.toContain("announceInstructions()");
  });
  test("it routes through sendGreeting — that is the mindResponse-class exemption, not a raw ws.send", () => {
    const announce = sessionUpdatedBlock.slice(sessionUpdatedBlock.indexOf("GREET_ANNOUNCE"));
    expect(announce).toContain("sendGreeting(");
    expect(announce).not.toContain("ws.send(");
    // sendGreeting is what sets awaitingResponse, which response.created reads as mindResponse.
    const sg = src.slice(src.indexOf("const sendGreeting = "), src.indexOf("const onOpen = () => {"));
    expect(sg).toContain("awaitingResponse = true;");
  });
  test("the payload carries the LIVE persona — response.instructions OVERRIDES the session's", () => {
    const ai = src.slice(src.indexOf("const announceInstructions = () =>"));
    expect(ai.slice(0, 200)).toContain("livePersona");
  });
  test("two sentences, never a list (L42: a greeting read a list 3x into an empty room)", () => {
    const dir = src.slice(src.indexOf("const ANNOUNCE_DIRECTION ="), src.indexOf("const announceInstructions"));
    expect(dir).toContain("AT MOST TWO SENTENCES");
    expect(dir).toContain("NEVER read a list");
  });
});

describe("LM_GREET=announce — the guards", () => {
  test("HIS FLOOR OUTRANKS IT: already speaking → skip, fall back to presence arming", () => {
    expect(sessionUpdatedBlock).toContain("speechStartedAt !== 0");
    expect(sessionUpdatedBlock).toContain("mouth opener skipped (user already speaking) — presence arming");
    const skip = sessionUpdatedBlock.slice(sessionUpdatedBlock.indexOf("speechStartedAt !== 0"));
    expect(skip.slice(0, 800)).toContain("openerArmed = true");
  });
  test("ONE PER CONNECTION: the flag exists, is per-connection, and gates the arm site", () => {
    expect(src).toContain("let announcedThisConn = false;");
    expect(sessionUpdatedBlock).toContain("announcedThisConn");
    expect(sessionUpdatedBlock).toContain("mouth opener skipped (already announced this connection)");
  });
  test("a spent opener stays spent — sendGreeting spends the CONNECTION, not just the arm", () => {
    const sg = src.slice(src.indexOf("const sendGreeting = "), src.indexOf("const onOpen = () => {"));
    expect(sg).toContain("announcedThisConn = true;");
  });
  test("THE LATENT DEFECT IS CLOSED: the presence fold path spends the connection too", () => {
    const fold = src.indexOf('say("info", "opening line folded into his first answer');
    expect(fold).toBeGreaterThan(0);
    expect(src.slice(fold - 500, fold)).toContain("announcedThisConn = true;");
    // and the legacy/presence arm can no longer re-enter after a fold
    expect(sessionUpdatedBlock).toContain("!greeted && !announcedThisConn");
  });
  test("the mouth-closed-for-the-whole-call fold spends it as well", () => {
    const f = src.indexOf('APIPLAN_VAD_CREATE_RESPONSE === "0") {');
    expect(f).toBeGreaterThan(0);
    expect(src.slice(f, f + 300)).toContain("announcedThisConn = true;");
  });
});

describe("LM_GREET=announce — what it must NOT change", () => {
  test("legacy still SENDS at the ack and presence still ARMS there, unchanged", () => {
    expect(sessionUpdatedBlock).toContain("if (GREET_LEGACY) sendGreeting();");
    expect(sessionUpdatedBlock).toContain("else if (GREET_PRESENCE) openerArmed = true;");
  });
  test("the empty-room predicate is single-sourced, and announce is legacy-shaped in it", () => {
    expect(src).toContain("const emptyRoomNow = () => !GREET_LEGACY && !GREET_ANNOUNCE && speechStartedAt === 0;");
    // no inlined copy may survive — a second definition is how the two drift apart
    const inlined = src.split("!GREET_LEGACY && speechStartedAt === 0").length - 1;
    expect(inlined).toBe(0);
  });
  test("the three noise gates are untouched — the absolute invariant", () => {
    expect(src).toContain("noise-blip auto-reply cancelled");
    expect(src).toContain("empty-transcript auto-reply cancelled");
    // Lane E (engine be3bb29) added ONE rider — a retry of an empty MOUTH reply is not the
    // MIND speaking — so the assignment now reads `awaitingResponse && !retryResponse`. The
    // invariant this guards is unchanged: a MIND-initiated response is still exempted from
    // the noise gates, and that exemption is still derived from awaitingResponse.
    expect(src).toMatch(/mindResponse = awaitingResponse(?: && !retryResponse)?;/);
  });
});
