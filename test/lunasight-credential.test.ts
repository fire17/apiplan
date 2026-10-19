// lunasight-credential.test.ts — GET /v1/lunasight/credential: the LunaSight app fetches the current
// Codex access token at run time instead of embedding it in the APK (Tami, LunaSight group ACF351C4,
// 2026-10-19: "the version that doesn't need reinstalls to swap the token").
//
// It hands out a live subscription bearer, so the gate is narrower than every other route: ONLY a
// store key labelled exactly "lunasight". Keyless (even in open mode), the owner's legacy key and
// any other store key are refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKey } from "../src/serve-keys.ts";
import { serve } from "../src/api.ts";

const DIR = mkdtempSync(join(tmpdir(), "ap-lunasight-cred-"));
const KEYS = join(DIR, "keys.json");
const LEDGER = join(DIR, "ledger.jsonl");
const AUTH = join(DIR, "auth.json");
const SAVED: Record<string, string | undefined> = {};
const ENV = ["APIPLAN_SERVE_KEY", "APIPLAN_API_KEY", "APIPLAN_SERVE_KEY_FILE", "APIPLAN_SERVE_OPEN", "APIPLAN_SERVE_KEYS_FILE", "APIPLAN_CODEX_AUTH", "APIPLAN_USAGE_LEDGER"];

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const EXP = Math.floor(Date.now() / 1000) + 5 * 86400;
const TOKEN = jwt(EXP);
const writeAuth = (token: string) => writeFileSync(AUTH, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: "acct-luna" } }));

let luna = "", other = "";
beforeAll(() => {
  for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.APIPLAN_CODEX_AUTH = AUTH;
  process.env.APIPLAN_USAGE_LEDGER = LEDGER;
  luna = createKey("lunasight", KEYS).key;
  other = createKey("friend-a", KEYS).key;
  writeAuth(TOKEN);
});
afterAll(() => { for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

const PATH = "/v1/lunasight/credential";

describe("GET /v1/lunasight/credential", () => {
  test("the lunasight key gets the current Codex access token, never cached", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: KEYS, token: "owner-legacy" });
    try {
      const r = await fetch(`${s.url}${PATH}`, { headers: { authorization: `Bearer ${luna}` } });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const j = await r.json() as any;
      expect(j).toEqual({ access_token: TOKEN, account_id: "acct-luna", expires_at: EXP * 1000 });
      // x-api-key works too, like every other route
      expect((await fetch(`${s.url}${PATH}`, { headers: { "x-api-key": luna } })).status).toBe(200);
    } finally { s.stop(); }
  });

  test("anyone else is refused: another store key, the owner's legacy key, keyless in open mode", async () => {
    process.env.APIPLAN_SERVE_OPEN = "1";
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: KEYS, token: "owner-legacy" });
    try {
      expect((await fetch(`${s.url}${PATH}`, { headers: { authorization: `Bearer ${other}` } })).status).toBe(403);
      expect((await fetch(`${s.url}${PATH}`, { headers: { authorization: "Bearer owner-legacy" } })).status).toBe(403);
      const anon = await fetch(`${s.url}${PATH}`);
      expect(anon.status).toBe(403);
      expect(await anon.text()).not.toContain(TOKEN);
    } finally { s.stop(); delete process.env.APIPLAN_SERVE_OPEN; }
  });

  test("a per-device lunasight-<device> key is accepted; a look-alike label is not", async () => {
    const dev = createKey("lunasight-dad", KEYS).key, fake = createKey("lunasightx", KEYS).key;
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: KEYS });
    try {
      expect((await fetch(`${s.url}${PATH}`, { headers: { authorization: `Bearer ${dev}` } })).status).toBe(200);
      expect((await fetch(`${s.url}${PATH}`, { headers: { authorization: `Bearer ${fake}` } })).status).toBe(403);
    } finally { s.stop(); }
  });

  test("keyless on a closed server never reaches it (401 at the gate)", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: KEYS });
    try { expect((await fetch(`${s.url}${PATH}`)).status).toBe(401); } finally { s.stop(); }
  });

  test("an expired or missing Codex login is 503, not a dead token", async () => {
    const s = serve({ port: 0, host: "127.0.0.1", keysFile: KEYS });
    try {
      writeAuth(jwt(Math.floor(Date.now() / 1000) - 60));
      const r = await fetch(`${s.url}${PATH}`, { headers: { authorization: `Bearer ${luna}` } });
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
    } finally { s.stop(); writeAuth(TOKEN); }
  });

  test("the token never lands in the usage ledger", () => {
    if (existsSync(LEDGER)) expect(readFileSync(LEDGER, "utf8")).not.toContain(TOKEN);
  });
});
