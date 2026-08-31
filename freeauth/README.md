# freeauth — Sign in with ChatGPT, from scratch

Turn a ChatGPT account (free or paid) into an OpenAI-compatible API — in the terminal
**and** in the browser. A clean-room reproduction of what Evan Zhou showed in
[*I Found OpenAI's $3B Loophole*](https://youtu.be/Ja6p4j0aeCw): nothing was read or
copied from his repo; everything below was re-derived from
[Codex CLI's open-source login crate](https://github.com/openai/codex/tree/main/codex-rs/login)
and probed live.

```
                     ┌──────────────────────── your machine ────────────────────────┐
  any OpenAI SDK ──▶ │ freeauth bridge  :1456/v1  ── injects Codex headers ──▶ chatgpt.com/backend-api/codex
  (openai, ai-sdk,   │   chat/completions · responses · models                     (streams only; bridge buffers)
   curl, agents)     │   creds: ~/.freeauth/auth.json  (or Codex's own ~/.codex/auth.json)
                     └──────────────────────────────────────────────────────────────┘
  a website ──▶ Sign in with ChatGPT ──▶ auth.openai.com ──▶ http://localhost:1455/auth/callback
                                                            └─ browser extension rewrites that hop
                                                               into a window message back to the page
                                                               → page swaps code for tokens (CORS ok)
                                                               → calls the bridge with its own bearer
```

## The mechanics (what the video explained, verified here)

| Piece | Fact | Where it came from |
|---|---|---|
| OAuth client | `app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`, public client + PKCE S256, no secret | `codex-rs/login/src/auth/manager.rs`, `server.rs` |
| Redirect | only `http://localhost:1455/auth/callback` | `server.rs` (`DEFAULT_PORT = 1455`) |
| Extra authorize params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs` | `build_authorize_url` |
| Token exchange | form-encoded `POST /oauth/token` (`authorization_code` + `code_verifier`) | `exchange_code_for_tokens` |
| Refresh | `POST /oauth/token` `{grant_type: refresh_token, refresh_token, client_id}` — refresh tokens rotate | `request_chatgpt_token_refresh` |
| Account id | JWT claim `https://api.openai.com/auth`.`chatgpt_account_id` | `token_data.rs` |
| Model endpoint | `POST https://chatgpt.com/backend-api/codex/responses` — Responses API, **stream only**, rejects `max_output_tokens`, `input` must be a list; headers `authorization`, `chatgpt-account-id`, `originator`, `session_id` | probed live |
| Model list | `GET …/codex/models?client_version=0.146.0` | probed live |
| CORS | `auth.openai.com/oauth/token` allows `*` (browser can exchange/refresh itself); `chatgpt.com/backend-api` does not (hence the bridge) | probed live |

## Terminal: `freeauth`

```sh
cd freeauth
bun cli.ts                 # first run: browser sign-in → ~/.freeauth/auth.json (0600); then serves
#   freeauth bridge on http://localhost:1456
#   export OPENAI_BASE_URL=http://localhost:1456/v1
#   export OPENAI_API_KEY=freeauth
bun cli.ts login|logout|whoami|token|serve [port]
```

If `codex` is already logged in on the machine, no second sign-in is asked — its
`~/.codex/auth.json` is read (never written).

```sh
curl localhost:1456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"hi"}]}'
```

Any bearer that is **not** a JWT (`sk-anything`, `freeauth`, none) means "the account
signed in on this machine"; a real ChatGPT JWT (what the web SDK sends) is forwarded
untouched. Chat Completions are translated to Responses both ways (tools, tool results,
images, `reasoning_effort`, `response_format`, streaming with `[DONE]`); `/v1/responses`
passes through; non-streaming callers get a buffered JSON reply.

Limits you cannot bridge around: your plan's rate limits and model list apply
(`gpt-4o` → "not supported when using Codex with a ChatGPT account"); OpenAI's Terms of
Use still apply. Only Codex-served models work — see `GET /v1/models`.

## Browser: two paths

### A. Your own browser, no extension (default)

The bridge runs on **your** machine, so it can be the `localhost:1455` callback catcher a
web page cannot be. Open the demo the bridge serves and sign in through it:

```sh
bun cli.ts                       # serves http://localhost:1456/ and the demo page
open http://localhost:1456/      # your normal browser
```

- Already signed in with `codex`/`freeauth login`? The page shows your account and is ready —
  **zero clicks, no extension.**
- Otherwise click **Sign in with ChatGPT**: the bridge (`POST /login`) opens your browser to
  OpenAI once, catches the callback locally, stores the token. No extension, no GitHub redirect.

Bridge endpoints for this: `GET /session` (who's signed in on this machine), `POST /login`,
`POST /logout`. The page calls the API with a dummy `Bearer freeauth` — a non-JWT bearer
means "use the machine account."

### B. A remote website, with the extension

Only needed when the page has **no local bridge** — then a plain tab genuinely can't read
`localhost:1455`, so the extension catches that hop.

1. **Extension** (`extension/`, MV3, ~60 lines): a `declarativeNetRequest` rule rewrites
   `http://localhost:1455/auth/callback?…` into the extension's own `callback.html`, whose
   script relays `{code, state}` through the background worker to every tab
   (`relay.js` posts it as a `window` message) **and** forwards the callback to the real
   `localhost:1455`, so `freeauth login` / `codex login` from a terminal keep working with
   the extension installed. Nothing is stored, nothing leaves the browser.
   <a id="install"></a>**Install:** `chrome://extensions` → Developer mode → *Load unpacked* → `freeauth/extension`.
2. **SDK** (`web/freeauth.js`, ES module, no deps): `signInWithChatGPT()` opens the OpenAI
   popup, waits for the relayed code (state-checked), exchanges it in-page against
   `auth.openai.com`, and stores tokens **encrypted at rest** (AES-GCM, key non-extractable
   in IndexedDB, ciphertext in localStorage). `getAccessToken()` refreshes silently.
   `authHeaders()` / `openaiOptions(bridge)` plug into fetch, the `openai` package, or the
   Vercel AI SDK.
3. **React** (`web/SignInWithChatGPT.jsx`): one component, `react` as the only peer.
4. **Demo** (`web/index.html`): served by the bridge at `http://localhost:1456/`.

```js
import { signInWithChatGPT, openaiOptions } from "./freeauth.js";
await signInWithChatGPT();
const openai = new OpenAI(await openaiOptions("http://localhost:1456"));   // openai npm
const r = await openai.chat.completions.create({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
```

The bridge is the only server involved; run it wherever your site can reach it. It
never persists a web user's token — the bearer is used for that request and dropped.

## Verification status (honest)

- `bun test` — 11 tests: PKCE/authorize-URL parity (CLI ⇄ web SDK), Chat⇄Responses
  conversion incl. tool calls, and the bridge against a fake upstream (header injection,
  stream→JSON buffering, string-input fix, error mapping, models filter). **Pass.**
- **Live, 2026-08-18:** `freeauth login` completed in the browser (screenshot showed
  OpenAI redirecting to `localhost:1455/auth/callback?code=…`; the listener exchanged it and
  wrote `auth.json`); refresh rotated tokens; the bridge answered
  `gpt-5.4-mini` non-stream, stream, tool call, `/v1/responses` stream + non-stream, and
  `/v1/models` on those creds; browser-style refresh (form-encoded, foreign `Origin`)
  returned 200 with `access-control-allow-origin: *`.
- **Extension e2e** (`bun run test:e2e`, drives Chrome for Testing over CDP): a navigation
  to `localhost:1455/auth/callback?code=ac_TEST&state=st_TEST` was redirected into
  `chrome-extension://…/callback.html?code=ac_TEST&state=st_TEST` and the demo tab received
  `{type:"freeauth:callback", code:"ac_TEST", state:"st_TEST"}`. **Pass.** (Branded Google
  Chrome ≥137 ignores `--load-extension`; the script takes `CHROME=` pointing at a Chrome
  for Testing binary.)
- **Extension-free browser path (2026-08-18):** the bridge-served demo at
  `http://localhost:1456/` was driven in a real browser — `/session` reported the machine
  account, models loaded, and a streamed chat returned "browser works, no extension".
- The **extension SDK path** (popup → OpenAI → relay → in-page exchange) still needs a human
  click at a real ChatGPT session for full end-to-end confirmation.

## Not done, on purpose

- No hosted demo (Vercel) — publishing is a separate, confirmed step; the bridge serves the
  same demo locally.
- No Chrome Web Store listing — load unpacked. A store id would let the SDK deep-link the
  install page instead of this README.
- Device-code flow (for headless boxes) — the video rejected it for handing your account
  to a server; so did we.
