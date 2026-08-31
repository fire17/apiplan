// The browser SDK's pure parts, run in Bun: its PKCE and authorize URL must match the CLI's.
import { test, expect } from "bun:test";
import { pkce as webPkce, authorizeUrl as webUrl, CLIENT_ID, REDIRECT_URI } from "../web/freeauth.js";
import { authorizeUrl as cliUrl, CLIENT_ID as CLI_ID, REDIRECT_URI as CLI_REDIRECT } from "../src/oauth.ts";
import { createHash } from "node:crypto";

test("web SDK and CLI agree on client, redirect and authorize URL", async () => {
  expect(CLIENT_ID).toBe(CLI_ID); expect(REDIRECT_URI).toBe(CLI_REDIRECT);
  expect(webUrl("CH", "ST")).toBe(cliUrl("CH", "ST"));
  const { verifier, challenge } = await webPkce();
  expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
});
