/**
 * A /health (or probe-detail) reading from a FRESH process.
 *
 * Why a subprocess: STATE_DIR and the outcomes Map are module-level constants in
 * src/api.ts — they are read once, at import. A test that wants to see how /health
 * answers for a DIFFERENT state dir therefore cannot reuse this process's module
 * graph; it has to start a new one. Argv:
 *   health   start the server on a free loopback port, print the /health body
 *   probe    print { [providerId]: probe().detail } — the credential fingerprint
 *            /health's outcome memory is keyed on
 * Both print exactly one line of JSON on stdout and exit 0.
 */
const mode = process.argv[2] ?? "health";

if (mode === "probe") {
  const p = await import("../../src/providers.ts");
  const out: Record<string, string> = {};
  for (const [id, prov] of Object.entries(p.PROVIDERS ?? {})) {
    try { out[id] = (prov as any).probe().detail ?? ""; } catch { out[id] = ""; }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const { serve } = await import("../../src/api.ts");
// token: "" — never inherit APIPLAN_API_KEY from the operator's shell, or this probe
// 401s against its own server.
const s = serve({ port: 0, host: "127.0.0.1", token: "" });
const r = await fetch(`${s.url}/health`);
const body = await r.json();
console.log(JSON.stringify(body));
s.stop();
process.exit(0);
