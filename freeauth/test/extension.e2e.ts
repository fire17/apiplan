// e2e for the extension mechanics, driven over CDP in headless Chrome:
//   navigation to http://localhost:1455/auth/callback?code=…&state=… (nothing listening)
//   → DNR redirects into callback.html → background broadcasts → relay.js in the demo tab
//   → the page's `message` listener sees {type:"freeauth:callback", code, state}.
// Run: bun test/extension.e2e.ts   (needs Google Chrome; not part of `bun test`)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "../src/bridge.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ext = resolve(import.meta.dir, "../extension");
const bridge = serve({ port: 0, webDir: resolve(import.meta.dir, "../web") });
const demo = `http://127.0.0.1:${bridge.port}/`;
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "fa-chrome-"))}`,
  `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });

async function json(u: string, tries = 40): Promise<any> {
  for (let i = 0; i < tries; i++) { try { return await (await fetch(u)).json(); } catch { await Bun.sleep(250); } }
  throw new Error(`no answer from ${u}`);
}
let id = 0;
async function cdp(ws: WebSocket, method: string, params: any = {}) {
  const me = ++id;
  return new Promise<any>((res, rej) => {
    const h = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.id === me) { ws.removeEventListener("message", h); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    ws.addEventListener("message", h); ws.send(JSON.stringify({ id: me, method, params }));
  });
}
const open = (u: string) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(u); w.onopen = () => res(w); w.onerror = () => rej(new Error("ws")); });

try {
  await json(`http://127.0.0.1:${port}/json/version`);
  const newTab = async (url: string) => { const t = await (await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" })).json(); const w = await open(t.webSocketDebuggerUrl); await cdp(w, "Page.enable"); await cdp(w, "Runtime.enable"); await cdp(w, "Page.navigate", { url }); await Bun.sleep(1500); return w; };
  await Bun.sleep(1000); // extension service worker settle
  const ws = await newTab(demo);
  const marker = await cdp(ws, "Runtime.evaluate", { expression: `document.documentElement.getAttribute("data-freeauth-ext")`, returnByValue: true });
  console.log("marker attribute:", marker.result.value);
  if (!marker.result.value) throw new Error("relay.js did not mark the page — extension not loaded?");
  await cdp(ws, "Runtime.evaluate", { expression: `window.__got = new Promise(r => addEventListener("message", e => { if (e.data?.type === "freeauth:callback") r(e.data); }))` });
  // a second tab hits the callback URL — exactly what OpenAI's redirect does at the end of sign-in
  await newTab("http://localhost:1455/auth/callback?code=ac_TEST&state=st_TEST");
  const got = await cdp(ws, "Runtime.evaluate", { expression: `Promise.race([window.__got, new Promise((_, j) => setTimeout(() => j(new Error("no callback message in 8s")), 8000))])`, awaitPromise: true, returnByValue: true });
  if (got.exceptionDetails) throw new Error(got.exceptionDetails.exception?.description ?? "eval failed");
  console.log("page received:", got.result.value);
  const ok = got.result.value.code === "ac_TEST" && got.result.value.state === "st_TEST";
  // and the redirected tab really is our extension page
  const list: any[] = await json(`http://127.0.0.1:${port}/json/list`);
  const cb = list.find((x) => x.url.startsWith("chrome-extension://") && x.url.includes("callback.html?code=ac_TEST"));
  console.log("callback tab:", cb?.url ?? "(not found)");
  console.log(ok && cb ? "PASS" : "FAIL"); process.exitCode = ok && cb ? 0 : 1;
} catch (e: any) { console.error("FAIL:", e.message); process.exitCode = 1; }
finally { chrome.kill(); bridge.stop(true); }
