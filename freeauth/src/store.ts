// store.ts — where the credentials live: ~/.freeauth/auth.json (mode 0600), same shape
// as Codex's own ~/.codex/auth.json so either file is readable. We never write Codex's.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expiresAt, refresh, type Tokens } from "./oauth.ts";

const HOME = homedir();
export const FILE = process.env.FREEAUTH_AUTH ?? join(HOME, ".freeauth", "auth.json");
const CODEX_FILE = process.env.FREEAUTH_CODEX_AUTH ?? join(HOME, ".codex", "auth.json");

type AuthFile = { auth_mode?: string; tokens?: Tokens; last_refresh?: string };

function readAuth(f: string): AuthFile | null {
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

export function save(tokens: Tokens) {
  mkdirSync(join(FILE, ".."), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ auth_mode: "chatgpt", tokens, last_refresh: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}
export function clear() { if (existsSync(FILE)) unlinkSync(FILE); }

/** Our file first, then Codex's — a machine with `codex` logged in needs no second login. */
export function load(): { tokens: Tokens; source: string } | null {
  for (const f of [FILE, CODEX_FILE]) {
    const t = readAuth(f)?.tokens;
    if (t?.access_token) return { tokens: t, source: f.replace(HOME, "~") };
  }
  return null;
}

/** A valid access token, refreshed (and persisted to OUR file) when within a minute of expiry. */
export async function accessToken(): Promise<{ token: string; account: string | undefined; source: string }> {
  const cur = load();
  if (!cur) throw new Error("not signed in — run `freeauth login`");
  let { tokens, source } = cur;
  if (expiresAt(tokens.access_token) < Date.now() + 60_000) {
    if (!tokens.refresh_token) throw new Error("access token expired and no refresh token — run `freeauth login`");
    tokens = { ...tokens, ...(await refresh(tokens.refresh_token)) };
    save(tokens);
    source = FILE.replace(HOME, "~");
  }
  return { token: tokens.access_token, account: tokens.account_id, source };
}
