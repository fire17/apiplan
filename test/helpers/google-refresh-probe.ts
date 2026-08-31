const SLOW_MS = 2500;
let oauthHits = 0;
const oauth = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch() {
    oauthHits++;
    await Bun.sleep(SLOW_MS);
    return Response.json({ access_token: "AT-refreshed", expires_in: 3600, token_type: "Bearer" });
  },
});
const ping = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response("pong"); } });
process.env.APIPLAN_GOOGLE_TOKEN_URL = `http://127.0.0.1:${oauth.port}/token`;

try {
  const providers = await import("../../src/providers.ts");
  const runtimeBefore = providers.providerRuntime.syncRefresh;
  providers.providerRuntime.syncRefresh = false;
  const t0 = performance.now();
  const served = fetch(`http://127.0.0.1:${ping.port}/`).then(async (r) => ({ pong: await r.text(), pongMs: performance.now() - t0 }));
  const creds = providers.google.creds();
  const pong = await served;
  for (let i = 0; i < 60 && oauthHits === 0; i++) await Bun.sleep(100);
  console.log(JSON.stringify({ ...pong, token: creds.token, oauthHits, runtimeBefore, runtimeAfter: providers.providerRuntime.syncRefresh }));
} finally {
  oauth.stop(true);
  ping.stop(true);
}
