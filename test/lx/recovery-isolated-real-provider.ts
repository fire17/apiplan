/**
 * recovery-isolated-real-provider.ts — proves the capacity hooks fire on a REAL provider acceptance,
 * without touching the live service.
 *
 * WHAT MAKES THIS ISOLATED, and why each part is necessary:
 *   · Its own `APIPLAN_HOME` (a fresh mkdtemp), so `capacity-state.json`, `capacity-events.jsonl` and
 *     `outcomes.json` are written THERE and the live `~/.apiplan` is never opened for writing. The
 *     live server's own capacity files stay absent, which is the truthful pre-activation state.
 *   · An EPHEMERAL port (`port: 0`), so port 8787 is neither bound, drained, nor disturbed. This
 *     process is not a second claimant for the live listener.
 *   · `HOME` is left ALONE on purpose: the real Anthropic credential lives in the login Keychain
 *     (`src/providers.ts:487-508`), and the point of this run is that the observation is attributed to
 *     the REAL credential chain. The credential is only ever READ; no login is written, forcibly
 *     refreshed, or switched.
 *   · Exactly ONE tiny request (`max_tokens: 1`, a three-word prompt) — enough for the vendor to
 *     accept the credential and open a stream, which is all the acceptance hook observes. No quota is
 *     deliberately exhausted and no refusal is provoked.
 *
 * WHAT IT PROVES: that a real 200 from the real vendor produces a real `capacity-state.json` line
 * keyed on the real credential-chain fingerprint, with `state: "open"` and NO fabricated
 * `window-reset` (a first reading is a baseline, not a recovery). That is the acceptance half of
 * CC-UC-20's observation path, on a real provider.
 *
 * WHAT IT CANNOT PROVE, stated here so the receipt cannot overclaim: the REFUSAL half. A
 * `window-reset` requires a genuine 429 followed by a genuine 200 on the same identity, and provoking
 * that means exhausting the human's quota, which is forbidden. The refusal→reopen edge is covered by
 * `test/capacity-hooks.test.ts` against a real resident with a synthetic provider endpoint; this run
 * covers the real-vendor attribution that the synthetic one cannot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.RECOVERY_PROBE_MODEL || "claude-opus-5";
const home = mkdtempSync(join(tmpdir(), "ap-recovery-real-"));
const snapshotPath = join(home, "capacity-state.json");
const journalPath = join(home, "capacity-events.jsonl");

process.env.APIPLAN_HOME = home;
process.env.APIPLAN_CAPACITY_STATE = snapshotPath;
process.env.APIPLAN_CAPACITY_EVENTS = journalPath;
process.env.APIPLAN_API_KEY = "";

const receipt: Record<string, unknown> = {
  probe: "recovery-isolated-real-provider",
  startedAt: new Date().toISOString(),
  isolation: { apiplanHome: home, port: "ephemeral (0)", livePortTouched: false, homeEnvOverridden: false },
  model: MODEL,
};

try {
  const { serve } = await import("../../src/api.ts");
  const { anthropic } = await import("../../src/providers.ts");
  const { isRealAccountIdent } = await import("../../src/capacity-signal.ts");

  // The identity this run must be attributed to, read BEFORE the call — non-secret digest only.
  const fp = anthropic.credFp?.();
  receipt.credentialChainFingerprint = fp?.ident;
  receipt.credentialIsRealIdentity = isRealAccountIdent(fp?.ident);
  receipt.credentialSource = anthropic.probe?.().detail;
  if (!isRealAccountIdent(fp?.ident)) throw new Error(`no real credential identity available (ident=${JSON.stringify(fp?.ident)}) — refusing to claim a real-provider observation`);

  const server = serve({ port: 0, host: "127.0.0.1", token: "" });
  receipt.isolation = { ...(receipt.isolation as object), serverUrl: server.url, serverPort: server.port, pid: process.pid };
  try {
    const before = existsSync(snapshotPath);
    const started = Date.now();
    const response = await fetch(`${server.url}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "say ok" }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    receipt.request = {
      snapshotExistedBefore: before,
      status: response.status,
      elapsedMs: Date.now() - started,
      // The upstream the request actually went to, so the receipt states the real endpoint rather
      // than asserting it. Default is the vendor; an override would show here.
      providerBase: process.env.APIPLAN_ANTHROPIC_BASE || "https://api.anthropic.com (default)",
      // Truncated: enough to prove a real answer, short enough to carry nothing of consequence.
      bodyHead: text.slice(0, 220),
    };
    if (response.status !== 200) throw new Error(`real provider did not accept: HTTP ${response.status} — ${text.slice(0, 300)}`);

    // The snapshot is written synchronously inside the acceptance hook, but the hook runs on the
    // generator's first pull; give the event loop its turn rather than racing it.
    for (let i = 0; i < 100 && !existsSync(snapshotPath); i++) await Bun.sleep(20);

    const snapshot = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : undefined;
    const journal = existsSync(journalPath) ? readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean) : [];
    receipt.observed = {
      snapshotWritten: !!snapshot,
      snapshotPath,
      wireVersion: snapshot?.v,
      writerPid: snapshot?.pid,
      lines: snapshot?.lines,
      journalPath,
      journalLineCount: journal.length,
      // A first real reading is a BASELINE. An empty journal here is the correct outcome, not a
      // failure: `unknown -> open` is deliberately not an edge (capacity-events.ts windowResetEdge).
      journalLines: journal,
    };

    const lines: Record<string, { provider?: string; account?: string; state?: string; model?: string; scope?: string; source?: string }> = snapshot?.lines ?? {};
    const mine = Object.values(lines).find(entry => entry.provider === "anthropic" && entry.account === fp?.ident);
    receipt.verdict = {
      realProviderAcceptanceObserved: !!mine && mine.state === "open",
      attributedToRealCredentialChain: !!mine,
      noFabricatedWindowReset: journal.length === 0,
      observedState: mine?.state,
      observedModel: mine?.model,
      observedScope: mine?.scope,
      observedSource: mine?.source,
      secretsInState: /accessToken|refreshToken|Bearer |sk-ant|"eyJ/.test(readFileSync(snapshotPath, "utf8")),
    };
  } finally { server.stop(); }
  receipt.status = "passed";
} catch (error: unknown) {
  receipt.status = "failed";
  receipt.error = error instanceof Error ? error.message : String(error);
} finally {
  receipt.finishedAt = new Date().toISOString();
  // Print before cleanup so the paths in the receipt are still meaningful to read back.
  console.log(JSON.stringify(receipt, null, 2));
  rmSync(home, { recursive: true, force: true });
}
