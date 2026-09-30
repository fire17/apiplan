import { afterEach, describe, expect, test } from "bun:test";
import { openProviderRequest } from "../src/provider-transport.ts";
import { aliasesFor, models, resolve } from "../src/registry.ts";
import { harnessRoster } from "../src/roster.ts";
import type { Built, Provider } from "../src/providers.ts";
import { providerCanUseWarmDaemon } from "../src/engine.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); server = undefined; });

const provider = (extra: Partial<Provider> = {}) => ({ wantsStreamFlag: true, ...extra }) as Provider;

describe("provider transport", () => {
  test("the default transport preserves the historical streamed POST", async () => {
    let observed: { method: string; body: unknown; header: string | null } | undefined;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      observed = { method: req.method, body: await req.json(), header: req.headers.get("x-test") };
      return new Response("ok");
    }});
    const built: Built = { url: `http://127.0.0.1:${server.port}/call`, headers: { "x-test": "kept" }, body: { prompt: "hello" } };
    expect(await (await openProviderRequest(provider(), built)).text()).toBe("ok");
    expect(observed).toEqual({ method: "POST", body: { prompt: "hello", stream: true }, header: "kept" });
  });

  test("providers that reject the stream flag retain their exact body", async () => {
    let body: unknown;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { body = await req.json(); return new Response("ok"); } });
    const built: Built = { url: `http://127.0.0.1:${server.port}/call`, headers: {}, body: { prompt: "hello" } };
    await openProviderRequest(provider({ wantsStreamFlag: false }), built);
    expect(body).toEqual({ prompt: "hello" });
  });

  test("a provider-owned transport receives the built request and cancellation signal", async () => {
    const built: Built = { url: "apiplan-online://website/generate", headers: {}, body: { version: 1 } };
    const controller = new AbortController();
    let seenBuilt: Built | undefined, seenSignal: AbortSignal | undefined;
    const p = provider({ open: async (value, signal) => { seenBuilt = value; seenSignal = signal; return new Response("website"); } });
    expect(await (await openProviderRequest(p, built, controller.signal)).text()).toBe("website");
    expect(seenBuilt).toBe(built);
    expect(seenSignal).toBe(controller.signal);
  });
});

describe("online model routes", () => {
  test("website routes bypass stale warm daemons while existing providers remain eligible", () => {
    expect(providerCanUseWarmDaemon(resolve("online/astra")!)).toBe(false);
    expect(providerCanUseWarmDaemon(resolve("online/chat")!)).toBe(false);
    expect(providerCanUseWarmDaemon(resolve("astra")!)).toBe(true);
    expect(providerCanUseWarmDaemon(resolve("opus")!)).toBe(true);
  });

  test("slash routes are exact and preserve established bare Astra", () => {
    expect(resolve("online/astra")).toMatchObject({ id: "online-gpt-6-astra", provider: "online" });
    expect(resolve("online/chat")).toMatchObject({ id: "online-chat-latest", provider: "online" });
    expect(resolve("astra")).toMatchObject({ id: "gpt-6-astra", provider: "openai" });
    expect(resolve("chat")).toBeNull();
    expect(aliasesFor(resolve("online/astra")!)).toEqual(["online/astra"]);
    expect(aliasesFor(resolve("online/chat")!)).toEqual(["online/chat"]);
  });

  test("only the two conservative website models are advertised", () => {
    expect(models("online").map((model) => model.id)).toEqual(["online-gpt-6-astra", "online-chat-latest"]);
    for (const model of models("online")) expect(model.efforts).toEqual(["low"]);
  });

  test("OM cards are text-only local caps with no invented token price", () => {
    const online = harnessRoster().filter((entry) => entry.id.startsWith("online-"));
    expect(online.map((entry) => entry.id)).toEqual(["online-gpt-6-astra", "online-chat-latest"]);
    for (const entry of online) {
      expect(entry).toMatchObject({ reasoning: true, efforts: ["low"], defaultLevel: "low", input: ["text"], contextWindow: 32_000, maxTokens: 4_096 });
      expect("cost" in entry).toBe(false);
    }
  });
});
