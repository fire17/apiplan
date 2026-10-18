#!/usr/bin/env python3
"""codex-relay — keep srv2's Codex access token fresh from the Mac's own Codex login.

The Mac's `codex` refreshes ~/.codex/auth.json about every 10 days. srv2 (/root/.codex/auth.json) holds an
ACCESS-ONLY copy: access_token + account_id, never refresh_token or id_token, so the two machines never share
a refresh-token family and can never rotate each other out. An access-only copy cannot refresh itself, so it
went cold on 2026-10-18 07:15Z. This job closes that gap: whenever the Mac's `last_refresh` changes, it pushes
the new access token over the ciphertext-only path (LiveMind's `file-push`: the tunnel carries only an
RSA-wrapped AES blob, never a plaintext token) and then checks srv2 /health shows the new expiry.

Design: Tami's token chain (voice ACAF9D54, 2026-10-09), go-ahead relayed by the MIND 2026-10-18.

    codex-relay.py            push if the Mac's last_refresh differs from the last one pushed
    codex-relay.py --force    push now regardless
    codex-relay.py --status   print what would happen; send nothing

State: ~/.apiplan/codex-relay.state (last_refresh pushed, when). Log lines never contain a token value.
"""
import base64, json, os, subprocess, sys, tempfile, time

HOME = os.path.expanduser("~")
AUTH = os.path.join(HOME, ".codex/auth.json")
STATE = os.path.join(HOME, ".apiplan/codex-relay.state")
HANDOFF = os.path.join(HOME, "Creations/LiveMind/server/handoff")
LABEL = os.environ.get("CODEX_RELAY_LABEL", "livemind-srv2")
REMOTE = "/root/.codex/auth.json"


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} codex-relay: {msg}", flush=True)


def jwt_exp(tok):
    try:
        return json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "=="))["exp"]
    except Exception:
        return None


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def remote_openai():
    """srv2's own view of the provider: (connected, expires) — read from /health, no secret involved."""
    cmd = ("curl -s -m 20 localhost:8787/health | python3 -c 'import json,sys;"
           "p=[p for p in json.load(sys.stdin)[\"providers\"] if p[\"id\"]==\"openai\"][0];"
           "print(p[\"connected\"],p.get(\"expires\"))'")
    r = subprocess.run([os.path.join(HANDOFF, "lm-srv"), "run", LABEL, cmd], capture_output=True, text=True, timeout=90)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else f"unreadable rc={r.returncode}"


def push(a):
    t = a["tokens"]
    body = {"auth_mode": a.get("auth_mode"), "OPENAI_API_KEY": None, "last_refresh": a.get("last_refresh"),
            "tokens": {"access_token": t["access_token"], "account_id": t["account_id"]}}
    d = tempfile.mkdtemp(prefix="codex-relay-")
    os.chmod(d, 0o700)
    path = os.path.join(d, "auth.json")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, json.dumps(body).encode())
        os.close(fd)
        r = subprocess.run([os.path.join(HANDOFF, "file-push"), LABEL, path, REMOTE],
                           capture_output=True, text=True, timeout=240)
        landed = [l for l in r.stdout.splitlines() if l.startswith("FILE-LANDED")]
        if r.returncode or not landed:
            raise SystemExit(f"file-push failed rc={r.returncode}: {(r.stdout + r.stderr)[-300:]}")
        log(landed[0])
    finally:
        try:
            with open(path, "r+b") as f:
                f.write(b"\0" * max(4096, os.path.getsize(path)))
        except Exception:
            pass
        try: os.unlink(path)
        except Exception: pass
        os.rmdir(d)


def main(argv):
    a = json.load(open(AUTH))
    t = a.get("tokens") or {}
    if not t.get("access_token") or not t.get("account_id"):
        log("Mac ~/.codex/auth.json has no access_token/account_id — nothing to relay"); return 1
    lr, exp = a.get("last_refresh"), jwt_exp(t["access_token"])
    exp_s = time.strftime("%Y-%m-%d %H:%M", time.gmtime(exp)) if exp else "?"
    st = load_state()
    due = "--force" in argv or st.get("last_refresh") != lr
    if exp and exp < time.time():
        log(f"Mac access token itself expired ({exp_s}Z) — run `codex` on the Mac; not pushing a dead token"); return 1
    if "--status" in argv:
        log(f"mac last_refresh={lr} exp={exp_s}Z · pushed={st.get('last_refresh')} at {st.get('pushed_at')} · due={due}")
        log(f"srv2 openai: {remote_openai()}"); return 0
    if not due:
        return 0
    log(f"Mac refreshed (last_refresh {st.get('last_refresh')} → {lr}, exp {exp_s}Z) — pushing access-only copy to {LABEL}")
    push(a)
    seen = remote_openai()
    log(f"srv2 openai after push: {seen}")
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump({"last_refresh": lr, "exp": exp, "pushed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "srv2": seen}, open(STATE, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
