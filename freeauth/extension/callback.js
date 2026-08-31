// The redirected OAuth callback lands here with ?code=…&state=… still attached.
// 1. Relay it to whichever page is waiting (state-checked there; useless without the
//    PKCE verifier that never left that page).
// 2. Also forward it to the real localhost:1455, so a `freeauth login` / `codex login`
//    started from a terminal keeps working while this extension is installed.
const q = new URLSearchParams(location.search);
const msg = { type: "freeauth:callback", code: q.get("code"), state: q.get("state"), error: q.get("error"), error_description: q.get("error_description") };
const say = (h, p = "") => { document.getElementById("h").textContent = h; document.getElementById("p").textContent = p; };

chrome.runtime.sendMessage(msg);
fetch("http://localhost:1455/auth/callback" + location.search).then(
  (r) => say(r.ok ? "Signed in — handed to the app on this computer." : "Signed in.", "You can close this window."),
  () => say(msg.error ? "Sign-in failed" : "Signed in.", msg.error ? `${msg.error}: ${msg.error_description ?? ""}` : "You can close this window."),
);
if (window.opener) setTimeout(() => window.close(), 1200);
