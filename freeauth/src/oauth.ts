// oauth.ts — the "Sign in with ChatGPT" flow, reverse-engineered from Codex CLI's
// open-source login crate (codex-rs/login): PKCE authorization-code grant against
// https://auth.openai.com, callback on http://localhost:1455/auth/callback, refresh
// via grant_type=refresh_token. No client secret exists — Codex is a public client.
import { createHash, randomBytes } from "node:crypto";

export const ISSUER = process.env.FREEAUTH_ISSUER ?? "https://auth.openai.com";
export const CLIENT_ID = process.env.FREEAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
export const PORT = Number(process.env.FREEAUTH_LOGIN_PORT ?? 1455);
export const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
export const ORIGINATOR = "codex_cli_rs";
const SCOPE = "openid profile email offline_access";

export type Tokens = { id_token: string; access_token: string; refresh_token: string; account_id?: string };

const b64url = (b: Buffer) => b.toString("base64url");

/** RFC 7636: verifier = 64 random bytes base64url; challenge = base64url(sha256(verifier)). */
export function pkce() {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl(challenge: string, state: string, redirectUri = REDIRECT_URI): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });
  return `${ISSUER}/oauth/authorize?${q}`;
}

/** Decode a JWT payload without verifying — we only read our own token's claims. */
export function claims(jwt: string): any {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()); } catch { return {}; }
}
export const accountId = (t: Pick<Tokens, "access_token" | "id_token">): string | undefined =>
  claims(t.access_token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
  claims(t.id_token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
export const expiresAt = (jwt: string): number => (claims(jwt).exp ?? 0) * 1000;

async function tokenRequest(body: Record<string, string> | string, json = false): Promise<Tokens> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
  const t = JSON.parse(text) as Tokens;
  if (!t.access_token) throw new Error(`token endpoint returned no access_token: ${text.slice(0, 200)}`);
  return { ...t, account_id: accountId(t) };
}

export const exchangeCode = (code: string, verifier: string, redirectUri = REDIRECT_URI) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: verifier });

/** Codex sends the refresh as JSON (not form-encoded); the endpoint accepts it that way. */
export const refresh = (refresh_token: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token, client_id: CLIENT_ID }, true);

/**
 * The full local login: listen on 1455, open the browser, wait for the callback,
 * exchange the code. Resolves with tokens; the browser tab shows a small done page.
 */
export async function login(opts: { open?: (url: string) => void; timeoutMs?: number } = {}): Promise<Tokens> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(32));
  const url = authorizeUrl(challenge, state);
  let settle!: (t: Tokens) => void, fail!: (e: Error) => void;
  const done = new Promise<Tokens>((res, rej) => { settle = res; fail = rej; });
  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/auth/callback") return new Response("not found", { status: 404 });
      if (u.searchParams.get("state") !== state) return new Response("state mismatch", { status: 400 });
      const err = u.searchParams.get("error");
      if (err) { fail(new Error(`${err}: ${u.searchParams.get("error_description") ?? ""}`)); return page("Sign-in failed", err); }
      const code = u.searchParams.get("code");
      if (!code) { fail(new Error("callback without code")); return page("Sign-in failed", "no code"); }
      try { settle(await exchangeCode(code, verifier)); return page("Signed in", "You can close this tab."); }
      catch (e: any) { fail(e); return page("Token exchange failed", e.message); }
    },
  });
  const timer = setTimeout(() => fail(new Error("login timed out")), opts.timeoutMs ?? 5 * 60_000);
  (opts.open ?? openBrowser)(url);
  try { return await done; } finally { clearTimeout(timer); server.stop(true); }
}

const page = (h: string, p: string) => new Response(
  `<!doctype html><meta charset=utf-8><title>${h}</title><body style="font:16px system-ui;padding:3rem"><h1>${h}</h1><p>${p}</p>`,
  { headers: { "content-type": "text/html" } });

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch {}
  console.error(`If the browser did not open, visit:\n${url}\n`);
}
