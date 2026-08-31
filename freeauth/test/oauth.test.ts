import { test, expect } from "bun:test";
import { pkce, authorizeUrl, claims, accountId, CLIENT_ID, REDIRECT_URI } from "../src/oauth.ts";
import { createHash } from "node:crypto";

test("pkce: S256 challenge of a base64url verifier", () => {
  const { verifier, challenge } = pkce();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
});

test("authorize url carries what Codex CLI sends", () => {
  const u = new URL(authorizeUrl("CH", "ST"));
  expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
  const p = u.searchParams;
  expect(p.get("client_id")).toBe(CLIENT_ID);
  expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(REDIRECT_URI).toBe("http://localhost:1455/auth/callback");
  expect(p.get("code_challenge")).toBe("CH"); expect(p.get("code_challenge_method")).toBe("S256");
  expect(p.get("state")).toBe("ST"); expect(p.get("response_type")).toBe("code");
  expect(p.get("scope")).toContain("offline_access");
});

test("account id comes from the access token's auth claim", () => {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "acc_1" } })}.sig`;
  expect(claims(jwt).exp).toBe(1);
  expect(accountId({ access_token: jwt, id_token: "" })).toBe("acc_1");
  expect(claims("garbage")).toEqual({});
});
