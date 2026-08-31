// One React component: <SignInWithChatGPT onSignIn={(user) => ...} bridge="http://localhost:1456" />
// Renders the button; when signed in, shows the account and a sign-out link.
// `react` is a peer — this file has no other import.
import { useEffect, useState } from "react";
import { signInWithChatGPT, signOut, user as whoami } from "./freeauth.js";

export default function SignInWithChatGPT({ onSignIn, onSignOut, className, style }) {
  const [u, setU] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  useEffect(() => { whoami().then((x) => { setU(x); if (x) onSignIn?.(x); }); }, []);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await signInWithChatGPT(); const x = await whoami(); setU(x); onSignIn?.(x); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const out = async () => { await signOut(); setU(null); onSignOut?.(); };
  if (u) return <span className={className} style={style}>{u.email} ({u.plan}) · <a href="#" onClick={(e) => { e.preventDefault(); out(); }}>Sign out</a></span>;
  return (
    <span className={className} style={style}>
      <button onClick={go} disabled={busy} style={btn}>{logo}{busy ? "Signing in…" : "Sign in with ChatGPT"}</button>
      {err && <small style={{ color: "#c00", marginLeft: 8 }}>{err}</small>}
    </span>
  );
}
const btn = { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 999, border: "1px solid #ddd", background: "#fff", font: "500 15px system-ui", cursor: "pointer" };
const logo = <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.78.78 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5zM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0L4 14.03a4.5 4.5 0 0 1-1.66-6.13zm16.6 3.86-5.83-3.39 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.41-.66zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.78.78 0 0 0-.39.68zm1.1-2.37 2.6-1.5 2.6 1.5v3l-2.6 1.5-2.6-1.5z"/></svg>;
