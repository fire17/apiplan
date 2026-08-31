#!/usr/bin/env bun
// freeauth — turn a ChatGPT login into an OpenAI API. `freeauth` = sign in if needed,
// then serve http://localhost:1456/v1 for any OpenAI-compatible client.
import { login, expiresAt, claims } from "./src/oauth.ts";
import { save, load, clear, accessToken, FILE } from "./src/store.ts";
import { serve } from "./src/bridge.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [cmd = "start", ...rest] = process.argv.slice(2);
const HERE = dirname(fileURLToPath(import.meta.url));

async function doLogin() {
  const t = await login();
  save(t);
  const c = claims(t.id_token);
  console.log(`signed in as ${c.email ?? "?"} (${c["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "plan ?"}) → ${FILE}`);
}

function whoami() {
  const cur = load();
  if (!cur) { console.log("not signed in"); process.exit(1); }
  const c = claims(cur.tokens.id_token);
  const exp = expiresAt(cur.tokens.access_token);
  console.log(`${c.email ?? "?"} · plan ${c["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "?"} · account ${cur.tokens.account_id ?? "?"}\n` +
    `token ${exp < Date.now() ? "EXPIRED" : "valid"} until ${new Date(exp).toISOString()} · from ${cur.source}`);
}

async function start(portArg?: string) {
  if (!load()) await doLogin();
  await accessToken(); // refresh now rather than on the first request
  const s = serve({ port: portArg ? Number(portArg) : undefined, webDir: join(HERE, "web") });
  console.log(`freeauth bridge on http://localhost:${s.port}\n` +
    `  export OPENAI_BASE_URL=http://localhost:${s.port}/v1\n  export OPENAI_API_KEY=freeauth\n` +
    `  demo page: http://localhost:${s.port}/`);
}

switch (cmd) {
  case "login": await doLogin(); break;
  case "logout": clear(); console.log(`removed ${FILE}`); break;
  case "whoami": case "status": whoami(); break;
  case "serve": case "start": await start(rest[0]); break;
  case "token": console.log((await accessToken()).token); break;
  default: console.log(`freeauth [start [port] | login | logout | whoami | token]`); process.exit(cmd === "help" || cmd === "-h" ? 0 : 1);
}
