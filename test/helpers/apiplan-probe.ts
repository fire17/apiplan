/**
 * A fresh-process probe for the RESIDENT hosts of this codebase.
 *
 * Why a subprocess: STATE_DIR, the outcomes Map and providerRuntime are module-level state
 * read once at import, and a resident host declares its posture when it STARTS. Neither can
 * be observed honestly from a test process that already imported the module graph for some
 * other purpose, so every mode here runs in its own process. Argv:
 *
 *   daemon   start the warm daemon (engine.runDaemon) and stay alive. Prints one line
 *            `READY <unix-socket-path|tcp-port>` when it is listening, then serves until
 *            killed. This is the SECOND resident host — the one behind `apiplan` CLI shims.
 *   serve    start the HTTP API (api.serve) on a free loopback port and stay alive. Prints
 *            `READY <port>`. Used when an external checker (apiplan-doctor) must talk to a
 *            server whose world this test controls.
 *   credfp   print { [id]: credFp() } — the fingerprint the outcome memory keys on, which
 *            a test must know to forge an entry ABOUT THE CREDENTIAL THAT IS THERE.
 *   posture  print { syncRefresh } after starting the host named by argv[3]
 *            ("serve" | "daemon"), so the declared posture is read from the same module
 *            instance the host itself mutated.
 */
const mode = process.argv[2] ?? "credfp";

if (mode === "credfp") {
  const p = await import("../../src/providers.ts");
  const out: Record<string, unknown> = {};
  for (const [id, prov] of Object.entries(p.PROVIDERS ?? {})) {
    try { out[id] = (prov as any).credFp ? (prov as any).credFp() : { cred: (prov as any).probe().detail, ident: (prov as any).probe().detail, exp: 0 }; }
    catch (e: any) { out[id] = { error: String(e?.message ?? e) }; }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (mode === "serve") {
  const { serve } = await import("../../src/api.ts");
  // token: "" — never inherit the operator's APIPLAN_API_KEY, or the probe 401s on itself.
  const s = serve({ port: 0, host: "127.0.0.1", token: "" });
  console.log(`READY ${s.port ?? new URL(s.url).port}`);
  // Stay alive; the parent kills us.
  await new Promise(() => {});
}

if (mode === "posture") {
  const which = process.argv[3] ?? "serve";
  if (which === "serve") {
    const { serve } = await import("../../src/api.ts");
    const s = serve({ port: 0, host: "127.0.0.1", token: "" });
    const { providerRuntime } = await import("../../src/providers.ts");
    console.log(JSON.stringify({ host: "serve", syncRefresh: providerRuntime?.syncRefresh }));
    s.stop(); process.exit(0);
  }
  const { ipc } = await import("../../src/platform.ts");
  const engine = await import("../../src/engine.ts");
  // NOT awaited: runDaemon() serves for ever by design, so awaiting it would never let the
  // posture be printed. The listener answering is the signal that boot is finished.
  void engine.runDaemon();
  const i = ipc();
  const hit = () => fetch(`http://apiplan/health`, { unix: (i as any).path } as any);
  for (let n = 0; n < 100; n++) { try { const r = await hit(); if (r.ok) break; } catch {} await Bun.sleep(100); }
  const { providerRuntime } = await import("../../src/providers.ts");
  console.log(JSON.stringify({ host: "daemon", syncRefresh: providerRuntime?.syncRefresh }));
  process.exit(0);
}

if (mode === "daemon") {
  const { ipc } = await import("../../src/platform.ts");
  const engine = await import("../../src/engine.ts");
  // runDaemon() never returns while it is serving, so the READY line is printed by a timer
  // that fires once the listener exists — the daemon writes its own "listening on" line to
  // stderr, and the socket/port is derivable from ipc() without racing that text.
  const i = ipc();
  setTimeout(() => { console.log(`READY ${i.kind === "unix" ? i.path : "tcp"}`); }, 300);
  await engine.runDaemon();
  await new Promise(() => {});
}

if (mode === "ollama-stub") {
  // A stand-in ollama daemon, in its OWN process on purpose: the tests that need it drive
  // the server through Bun.spawnSync, which blocks the parent's event loop — a stub served
  // from inside the test process would be unreachable for exactly as long as it is needed,
  // and every provider probe would time out into "disconnected" (observed).
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    return new URL(req.url).pathname === "/api/version"
      ? Response.json({ version: "0.0.0-stub" })
      : Response.json({ models: [] });
  } });
  console.log(`READY ${s.port}`);
  await new Promise(() => {});
}
