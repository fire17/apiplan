#!/usr/bin/env python3
"""codex-relay — keep every consumer of the Mac's Codex login fresh (Tami's token chain, voice ACAF9D54).

The Mac's ~/.codex/auth.json is the ROOT of the chain. Consumers hold ACCESS-ONLY copies (access_token +
account_id, never refresh_token or id_token, so nobody else can rotate the refresh-token family):
  · srv2 /root/.codex/auth.json — pushed over LiveMind's ciphertext-only `file-push` (the tunnel carries only
    an RSA-wrapped AES blob, never a plaintext token), then srv2 /health is read back for the new expiry
    — or, while ~/.apiplan/codex-relay.srv2-hold exists (srv2 runs acct-b), to srv2's Codex account-pool member
    /root/.apiplan-creds/pool/openai/acct-mac.json instead, so acct-mac backs acct-b up without replacing it
  · the LunaSight APK — rebuilt, live-proven and shipped by ~/Creations/lunasight/bin/lunasight-token-ship.py

An access-only copy cannot refresh itself, and Codex 0.162.1 only refreshes its own token inside the last
5 minutes before exp (no background refresh) — so on its own, every consumer dies at expiry (srv2 and
LunaSight both did on 2026-10-18). Two legs close that:

  EARLY REFRESH  when the Mac token has < 72 h left and has not been refreshed since it was issued
                 (last_refresh <= exp - 10 d + 1 h), force ONE refresh through Codex's sanctioned path:
                 `codex app-server` over stdio → initialize → account/read {refreshToken: true}, which in
                 managed auth mode "triggers the normal refresh-token flow" (app-server protocol v2,
                 GetAccountParams). No hand-rolled OAuth. auth.json is backed up first (0600, last 3 kept)
                 and the new exp must land ~+10 d, else the backup is restored and nothing is pushed.
  RELAY          whenever last_refresh differs from the last one relayed: push srv2, then run the
                 LunaSight shipper and log its exit code (0 = shipped or nothing to do; see its docstring).

    codex-relay.py              one pass: early refresh if due, then relay if last_refresh changed
    codex-relay.py --dry-run    print the plan for both legs and probe app-server with refreshToken:false
                                (read-only: proves the channel, refreshes nothing, sends nothing)
    codex-relay.py --status     Mac vs srv2 side by side; sends nothing
    codex-relay.py --force      relay now even if last_refresh did not change (never forces a refresh)
    codex-relay.py --account NAME [...]   the same two legs for a SECOND chain rooted at
                                ~/.codex-accounts/NAME/auth.json (CODEX_HOME for app-server), pushed to srv2 only
                                (no LunaSight, the srv2 hold does not apply: srv2 RUNS this account). Its own state
                                file; the first pass only records what srv2 already holds and pushes nothing.

State: ~/.apiplan/codex-relay.state. No log line, state file or backup name ever carries a token value.
"""
import base64, glob, json, os, select, shutil, subprocess, sys, tempfile, time

HOME = os.path.expanduser("~")
AUTH = os.path.join(HOME, ".codex/auth.json")
STATE = os.path.join(HOME, ".apiplan/codex-relay.state")
HANDOFF = os.path.join(HOME, "Creations/LiveMind/server/handoff")
LUNASIGHT = os.path.join(HOME, "Creations/lunasight/bin/lunasight-token-ship.py")
LUNASIGHT_LOG = os.path.join(HOME, ".livemind/lunasight/token-ship.log")
RELAY_LOG = os.path.join(HOME, ".livemind/codex-relay.log")
# srv2 can run on a DIFFERENT ChatGPT account than the Mac (2026-10-22, Tami AC483A86: srv2 → acct-b). While this
# file exists the relay never pushes the Mac's token to srv2 — it would overwrite that account — and records the
# pass as relayed so LunaSight is still shipped once per Mac refresh. Remove the file to resume pushing.
SRV2_HOLD = os.path.join(HOME, ".apiplan/codex-relay.srv2-hold")
LABEL = os.environ.get("CODEX_RELAY_LABEL", "livemind-srv2")
REMOTE = "/root/.codex/auth.json"
# While held, the Mac's own chain (acct-mac) still reaches srv2 — as an account-pool MEMBER, never over srv2's own
# login (2026-10-28, Tami AC001495: "acct-mac is good for acct-b backup on codex"). apiplan's Codex pool reads this
# dir (APIPLAN_CODEX_POOL_DIR); its `.registry.json` ranks acct-mac `backup`, so acct-b serves first.
POOL_REMOTE = os.environ.get("CODEX_RELAY_POOL_REMOTE", "/root/.apiplan-creds/pool/openai/acct-mac.json")
CODEX = shutil.which("codex") or "/opt/homebrew/bin/codex"
# --account NAME (2026-10-27, MIND: srv2 runs on acct-b, logged in on the Mac with
# `CODEX_HOME=~/.codex-accounts/acct-b codex login --device-auth`). None = the Mac's own ~/.codex chain.
ACCOUNT = None
CODEX_HOME = None

DAY = 86400
EARLY_WINDOW = 72 * 3600      # refresh when less than this is left
LIFETIME = 10 * DAY           # what a fresh Codex access token lives
LIFETIME_SLACK = DAY          # a refreshed exp must land within LIFETIME ± this of now
KEEP_BACKUPS = 3


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} codex-relay: {msg}", flush=True)


def ts(epoch):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(epoch)) + "Z" if epoch else "?"


def jwt_exp(tok):
    try:
        return json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "=="))["exp"]
    except Exception:
        return None


def utc_epoch(s):
    import calendar
    try:
        return calendar.timegm(time.strptime(s.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


def read_auth():
    a = json.load(open(AUTH))
    t = a.get("tokens") or {}
    return a, t, a.get("last_refresh"), jwt_exp(t.get("access_token", ""))


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(st, open(STATE, "w"))


# ─────────────────────────── early refresh ───────────────────────────

def refresh_plan(lr, exp, now):
    """(due, reason). Due only when the token is close to exp AND is still the one Codex issued — so a refresh
    that did not move exp can never loop: its last_refresh is newer than exp - LIFETIME and the guard holds."""
    if not exp:
        return False, "no exp in the Mac access token"
    left = exp - now
    lr_e = utc_epoch(lr or "")
    issued = exp - LIFETIME
    if left <= 0:
        return False, f"already expired at {ts(exp)} — needs `codex` on the Mac, not a relay"
    if left >= EARLY_WINDOW:
        return False, f"{left / 3600:.1f} h left (window opens at {ts(exp - EARLY_WINDOW)})"
    if lr_e is None or lr_e > issued + 3600:
        return False, f"{left / 3600:.1f} h left but last_refresh {lr} is newer than issue {ts(issued)} — already refreshed once"
    return True, f"{left / 3600:.1f} h left and last_refresh {lr} is the issue time — refresh now"


def app_server_account_read(refresh, timeout=90):
    """JSON-RPC over `codex app-server` stdio: initialize → initialized → account/read. Returns the result dict
    (account type / plan / email — never tokens) or raises. The child is always terminated."""
    env = dict(os.environ, CODEX_HOME=CODEX_HOME) if CODEX_HOME else None
    p = subprocess.Popen([CODEX, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
    def send(o):
        p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
    def wait_for(rid, deadline):
        while time.time() < deadline:
            r, _, _ = select.select([p.stdout], [], [], max(0.1, deadline - time.time()))
            if not r:
                continue
            line = p.stdout.readline()
            if not line:
                raise RuntimeError(f"app-server closed stdout (rc={p.poll()})")
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("id") == rid:
                if "error" in m:
                    raise RuntimeError(f"app-server error on id {rid}: {str(m['error'].get('message', m['error']))[:200]}")
                return m.get("result")
        raise TimeoutError(f"no app-server reply to id {rid} within {timeout}s")
    try:
        deadline = time.time() + timeout
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"clientInfo": {"name": "apiplan-codex-relay", "version": "1"}}})
        wait_for(1, deadline)
        send({"jsonrpc": "2.0", "method": "initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "account/read", "params": {"refreshToken": bool(refresh)}})
        return wait_for(2, deadline) or {}
    finally:
        try: p.stdin.close()
        except Exception: pass
        p.terminate()
        try: p.wait(5)
        except Exception: p.kill()


def describe(result):
    acct = (result or {}).get("account") or {}
    return f"account type={acct.get('type')} plan={acct.get('planType')}"


def backup_auth():
    dst = f"{AUTH}.bak-relay-{time.strftime('%Y%m%dT%H%M%S')}"
    shutil.copy2(AUTH, dst)
    os.chmod(dst, 0o600)
    for old in sorted(glob.glob(f"{AUTH}.bak-relay-*"))[:-KEEP_BACKUPS]:
        os.unlink(old)
    return dst


def early_refresh(now):
    a, t, lr, exp = read_auth()
    due, why = refresh_plan(lr, exp, now)
    if not due:
        return False
    log(f"EARLY REFRESH due: {why}")
    bak = backup_auth()
    log(f"backed up auth.json → {os.path.basename(bak)}")
    try:
        log(f"app-server account/read refreshToken=true → {describe(app_server_account_read(True))}")
    except Exception as e:
        log(f"refresh call failed: {e} — auth.json left as Codex left it, nothing pushed this pass")
        return False
    _, _, lr2, exp2 = read_auth()
    ok = exp2 and lr2 != lr and abs((exp2 - time.time()) - LIFETIME) <= LIFETIME_SLACK
    if not ok:
        log(f"refresh did NOT land (last_refresh {lr} → {lr2}, exp {ts(exp)} → {ts(exp2)}) — restoring the backup")
        shutil.copy2(bak, AUTH); os.chmod(AUTH, 0o600)
        return False
    log(f"refresh landed: last_refresh {lr} → {lr2}, exp {ts(exp)} → {ts(exp2)} (+{(exp2 - time.time()) / DAY:.1f} d)")
    return True


# ─────────────────────────── relay ───────────────────────────

def remote_openai():
    """srv2's own view of the provider: (connected, expires) — read from /health, no secret involved."""
    # The owner key is read from srv2's own key file AT RUNTIME on srv2, so the command text (which the tunnel
    # logs) only ever holds the path — keyless /health answers just "alive" once srv2 stops serving open.
    cmd = ("curl -s -m 20 -H \"authorization: Bearer $(cat /root/.apiplan-owner.key)\" localhost:8787/health | python3 -c 'import json,sys;"
           "p=[p for p in json.load(sys.stdin)[\"providers\"] if p[\"id\"]==\"openai\"][0];"
           "print(p[\"connected\"],p.get(\"expires\"))'")
    r = subprocess.run([os.path.join(HANDOFF, "lm-srv"), "run", LABEL, cmd], capture_output=True, text=True, timeout=90)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else f"unreadable rc={r.returncode}"


def push_srv2(a, remote=None):
    remote = remote or REMOTE
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
        r = subprocess.run([os.path.join(HANDOFF, "file-push"), LABEL, path, remote],
                           capture_output=True, text=True, timeout=240)
        landed = [l for l in r.stdout.splitlines() if l.startswith("FILE-LANDED")]
        if r.returncode or not landed:
            raise RuntimeError(f"file-push failed rc={r.returncode}: {(r.stdout + r.stderr)[-300:]}")
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


def run_lunasight():
    """Detached: the shipper takes 2-4 min (live proof + release build + phone-verified autoship) and must not
    hold the 15-min tick. A tiny sh wrapper appends its exit code to this job's log when it finishes; its own
    stdout goes to its own log. It is idempotent and takes its own lock (exit 7 if another run holds it)."""
    if not os.path.exists(LUNASIGHT):
        log(f"lunasight shipper missing at {LUNASIGHT} — skipped"); return None
    os.makedirs(os.path.dirname(LUNASIGHT_LOG), exist_ok=True)
    wrapper = ('"$1" "$2" >> "$3" 2>&1; rc=$?; '
               'printf "%s codex-relay: lunasight-token-ship exit=%s\\n" "$(date +%Y-%m-%dT%H:%M:%S)" "$rc" >> "$4"')
    # launchd's PATH has no ~/.local/bin, where wa-mind lives: the shipper's group post died on it (2026-10-25).
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([os.path.join(HOME, ".local/bin"), env.get("PATH", "/usr/bin:/bin")])
    subprocess.Popen(["/bin/sh", "-c", wrapper, "sh", sys.executable, LUNASIGHT, LUNASIGHT_LOG, RELAY_LOG],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True, env=env)
    log(f"lunasight-token-ship started detached (its output → {LUNASIGHT_LOG}; exit code lands here)")
    return "started"


def relay(a, lr, exp, st):
    ok_srv2 = False
    if os.path.exists(SRV2_HOLD) and not ACCOUNT:
        why = open(SRV2_HOLD).read().strip()[:160]
        log(f"srv2 login HELD ({SRV2_HOLD}: {why or 'no reason given'}) — srv2 keeps its own Codex login; "
            f"this chain goes to its pool member {POOL_REMOTE}")
        seen = "held"
        if POOL_REMOTE:
            try:
                push_srv2(a, POOL_REMOTE)
                ok_srv2 = True
                seen = f"pool member {os.path.basename(POOL_REMOTE)}"
            except Exception as e:
                log(f"srv2 pool push failed: {e} — will retry next pass")
        else:
            ok_srv2 = True  # no pool member configured: nothing to retry
    else:
        try:
            push_srv2(a)
            ok_srv2 = True
        except Exception as e:
            log(f"srv2 push failed: {e} — will retry next pass")
        seen = remote_openai()
        log(f"srv2 openai after push: {seen}")
    rc = None if ACCOUNT else run_lunasight()
    if ok_srv2:
        st.update({"last_refresh": lr, "exp": exp, "pushed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "srv2": seen})
    st["lunasight_rc"] = rc
    save_state(st)


def use_account(name):
    """Point every path at the second chain rooted at ~/.codex-accounts/NAME."""
    global ACCOUNT, CODEX_HOME, AUTH, STATE
    if not name or "/" in name or name.startswith("."):
        raise SystemExit(f"codex-relay: bad --account {name!r}")
    ACCOUNT = name
    CODEX_HOME = os.path.join(HOME, ".codex-accounts", name)
    AUTH = os.path.join(CODEX_HOME, "auth.json")
    STATE = os.path.join(HOME, f".apiplan/codex-relay.{name}.state")


def main(argv):
    if "--account" in argv:
        i = argv.index("--account")
        use_account(argv[i + 1] if i + 1 < len(argv) else "")
    now = time.time()
    a, t, lr, exp = read_auth()
    if not t.get("access_token") or not t.get("account_id"):
        log(f"{AUTH} has no access_token/account_id — nothing to relay"); return 1
    st = load_state()
    if ACCOUNT:
        log(f"chain: account {ACCOUNT} ({AUTH}) → {LABEL} only")

    if "--dry-run" in argv:
        due, why = refresh_plan(lr, exp, now)
        log(f"mac last_refresh={lr} exp={ts(exp)} · now={ts(now)} · {(exp - now) / 3600:.1f} h left")
        log(f"EARLY REFRESH: {'WOULD FIRE' if due else 'not due'} — {why}")
        log(f"   window opens {ts(exp - EARLY_WINDOW)}; guard: last_refresh <= {ts(exp - LIFETIME + 3600)}; "
            f"backup → {AUTH}.bak-relay-<ts>; accept new exp in {LIFETIME / DAY:.0f} ± {LIFETIME_SLACK / DAY:.0f} d")
        try:
            log(f"   app-server probe (refreshToken=false, read-only): {describe(app_server_account_read(False))}")
        except Exception as e:
            log(f"   app-server probe FAILED: {e}")
        relay_due = st.get("last_refresh") != lr
        if os.path.exists(SRV2_HOLD) and not ACCOUNT: log(f"SRV2 HOLD present ({SRV2_HOLD}) — a due relay leaves srv2's login alone, pushes the pool member {POOL_REMOTE}, ships LunaSight")
        if ACCOUNT and not st:
            log(f"RELAY: first pass SEEDS state from {lr} (srv2 already holds this login) — pushes nothing; "
                f"later passes file-push {LABEL}:{REMOTE} when last_refresh moves")
        else:
            log(f"RELAY: {'due' if relay_due else 'not due'} — last relayed {st.get('last_refresh')} at {st.get('pushed_at')}; "
                f"on due: file-push {LABEL}:{POOL_REMOTE if os.path.exists(SRV2_HOLD) and not ACCOUNT else REMOTE}" + ("" if ACCOUNT else f", then {LUNASIGHT} (last rc {st.get('lunasight_rc')})"))
        return 0

    if "--status" in argv:
        log(f"mac last_refresh={lr} exp={ts(exp)} · relayed={st.get('last_refresh')} at {st.get('pushed_at')} "
            f"· lunasight rc={st.get('lunasight_rc')}")
        log(f"srv2 openai: {remote_openai()}"); return 0

    if exp and exp < now:
        log(f"Mac access token itself expired ({ts(exp)}) — run `codex` on the Mac; not pushing a dead token"); return 1

    if ACCOUNT and not st and "--force" not in argv:
        # srv2 already holds this login (pushed when it was made) — record it instead of re-pushing the same token
        st.update({"last_refresh": lr, "exp": exp, "pushed_at": None, "srv2": "seeded (already on srv2)"})
        save_state(st)
        log(f"seeded state: last_refresh {lr} (exp {ts(exp)}) is what srv2 holds — nothing pushed")

    if early_refresh(now):
        a, t, lr, exp = read_auth()

    if "--force" in argv or st.get("last_refresh") != lr:
        log(f"relaying last_refresh {st.get('last_refresh')} → {lr} (exp {ts(exp)}) to {LABEL}"
            + ("" if ACCOUNT else " + LunaSight"))
        relay(a, lr, exp, st)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
