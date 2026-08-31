// freeauth.js — "Sign in with ChatGPT" for any website. Zero dependencies, ES module.
//
//   import { signInWithChatGPT, getAccessToken, authHeaders, signOut } from "./freeauth.js";
//   await signInWithChatGPT();                       // popup → OpenAI login → tokens (encrypted, this browser)
//   fetch(BRIDGE + "/v1/chat/completions", { headers: await authHeaders(), ... })
//
// The OAuth client is Codex CLI's (a public client, PKCE, no secret) whose only allowed
// redirect is http://localhost:1455/auth/callback — the freeauth browser extension turns
// that hop into a window message back to this page. Token exchange happens here, in the
// browser, straight against auth.openai.com (it allows CORS). Model calls go through a
// freeauth bridge (chatgpt.com does not allow CORS), which forwards the bearer unchanged.

export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const EXTENSION_INSTALL_URL = "https://github.com/fire17/apiplan/tree/main/freeauth/extension#install";
const SCOPE = "openid profile email offline_access";
const KEY = "freeauth:tokens";

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const claims = (jwt) => { try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; } };

export const hasExtension = () => document.documentElement.hasAttribute("data-freeauth-ext");

export async function pkce() {
  const verifier = rand(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export const authorizeUrl = (challenge, state) => `${ISSUER}/oauth/authorize?` + new URLSearchParams({
  response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPE,
  code_challenge: challenge, code_challenge_method: "S256", id_token_add_organizations: "true",
  codex_cli_simplified_flow: "true", state, originator: "codex_cli_rs",
});

async function tokenRequest(params) {
  const r = await fetch(`${ISSUER}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`token endpoint ${r.status}: ${t.error_description ?? t.error ?? "no access_token"}`);
  return t;
}

/** Opens the OpenAI sign-in popup; resolves with the stored tokens. */
export async function signInWithChatGPT({ onNeedExtension } = {}) {
  if (!hasExtension()) {
    if (onNeedExtension) onNeedExtension(EXTENSION_INSTALL_URL); else window.open(EXTENSION_INSTALL_URL, "_blank");
    throw new Error("freeauth extension not installed");
  }
  const { verifier, challenge } = await pkce();
  const state = rand(32);
  const popup = window.open(authorizeUrl(challenge, state), "freeauth-signin", "popup,width=520,height=760");
  if (!popup) throw new Error("popup blocked");
  const code = await new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.source !== window || e.data?.type !== "freeauth:callback" || e.data.state !== state) return;
      cleanup();
      e.data.error ? reject(new Error(`${e.data.error}: ${e.data.error_description ?? ""}`)) : resolve(e.data.code);
    };
    const poll = setInterval(() => { if (popup.closed) { clearInterval(poll); setTimeout(() => { cleanup(); reject(new Error("sign-in window closed")); }, 2000); } }, 500);
    const cleanup = () => { removeEventListener("message", onMsg); clearInterval(poll); };
    addEventListener("message", onMsg);
  });
  const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier });
  await save(tokens);
  return tokens;
}

/** A valid access token (refreshed when within a minute of expiry), or null when signed out. */
export async function getAccessToken() {
  let t = await load();
  if (!t) return null;
  if ((claims(t.access_token).exp ?? 0) * 1000 < Date.now() + 60_000) {
    if (!t.refresh_token) { await signOut(); return null; }
    t = { ...t, ...(await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT_ID })) };
    await save(t);
  }
  return t.access_token;
}
export const accountId = (jwt) => claims(jwt)["https://api.openai.com/auth"]?.chatgpt_account_id;
export async function user() { const t = await load(); if (!t) return null; const c = claims(t.id_token); return { email: c.email, plan: c["https://api.openai.com/auth"]?.chatgpt_plan_type, account: accountId(t.access_token) }; }
export const isSignedIn = async () => !!(await load());
export async function signOut() { localStorage.removeItem(KEY); }

/** Headers for a request to a freeauth bridge (or anything that takes a ChatGPT bearer). */
export async function authHeaders() {
  const token = await getAccessToken();
  if (!token) throw new Error("not signed in");
  return { authorization: `Bearer ${token}`, "chatgpt-account-id": accountId(token) ?? "" };
}
/** Options for `new OpenAI(...)` (openai npm) or `createOpenAI(...)` (Vercel AI SDK). */
export async function openaiOptions(bridge = "http://localhost:1456") {
  const token = await getAccessToken();
  if (!token) throw new Error("not signed in");
  return { baseURL: `${bridge.replace(/\/$/, "")}/v1`, apiKey: token, dangerouslyAllowBrowser: true };
}

// ── at-rest encryption: AES-GCM key kept non-extractable in IndexedDB, ciphertext in localStorage ──
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("freeauth", 1); r.onupgradeneeded = () => r.result.createObjectStore("k"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = (db, mode, f) => new Promise((res, rej) => { const q = f(db.transaction("k", mode).objectStore("k")); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
async function key() {
  const db = await idb();
  let k = await tx(db, "readonly", (s) => s.get("aes"));
  if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await tx(db, "readwrite", (s) => s.put(k, "aes")); }
  return k;
}
async function save(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  localStorage.setItem(KEY, JSON.stringify({ iv: b64url(iv), ct: b64url(new Uint8Array(ct)) }));
}
async function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const { iv, ct } = JSON.parse(raw);
    const un = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: un(iv) }, await key(), un(ct))));
  } catch { localStorage.removeItem(KEY); return null; }
}
