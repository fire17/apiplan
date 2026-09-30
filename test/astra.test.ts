// GPT-6 Astra (gpt-6-astra, OpenAI, 2026-09-05) — the wire contract this proxy holds for
// it, with no network and no credentials. The live receipts behind these shapes are in
// DARWIN.md round 25: turn 2 of a two-turn transcript on one prompt_cache_key came back
// with 1,024 `cached_tokens` from the Codex subscription endpoint.
import { expect, test, describe } from "bun:test";
import { openai } from "../src/providers.ts";
import { resolve, aliasesFor, models } from "../src/registry.ts";
import { defaults } from "../src/commands.ts";
import { parseArgs } from "../src/engine.ts";

const CREDS = { token: "T", account: "ACC", source: "test" };
const astra = () => resolve("astra")!;

describe("gpt-6-astra is addressable", () => {
  test.each(["astra", "gpt6astra", "gpt-6-astra", "GPT-6-Astra", "gpt6"])("%s → gpt-6-astra", (name) => {
    expect(resolve(name)?.id).toBe("gpt-6-astra");
  });
  // Astra was the newest gpt from 2026-09-05; GPT-6.1-Sol (listed from Codex client 0.159.0,
  // 2026-09-30) outranks it once the catalog is read at that version. Either cache state is valid,
  // so the family alias must follow whichever is newest — and Astra stays reachable by name.
  const newestGpt = () => models("openai").find((m) => m.family === "gpt" && m.version.length)!.id;
  test("the family alias follows the newest gpt and the older variants stay reachable", () => {
    expect(["gpt-6.1-sol", "gpt-6-astra"]).toContain(newestGpt());
    expect(resolve("gpt")?.id).toBe(newestGpt());
    expect(resolve("codex")?.id).toBe(newestGpt());
    expect(resolve("sol")?.variant).toBe("sol");
    expect(resolve("gpt56sol")?.id).toBe("gpt-5.6-sol");
    expect(resolve("gpt56")?.id).toBe("gpt-5.6-sol");
  });
  test("aliases and efforts come from the catalog entry — minus `ultra`, which the endpoint rejects", () => {
    expect(aliasesFor(astra())).toEqual([...(newestGpt() === "gpt-6-astra" ? ["gpt"] : []), "gpt6astra", "astra"]);
    // live 2026-09-05: reasoning.effort 'ultra' → 400 on gpt-5.6-sol and gpt-6-astra;
    // 'minimal' → 400 on gpt-6-astra. What is advertised must be what is accepted.
    expect(openai.efforts(astra())).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const e of ["low", "high", "xhigh", "max"]) {
      expect(openai.build(astra(), [{ role: "user", text: "hi" }], { effort: e }, CREDS).body.reasoning).toEqual({ effort: e });
    }
  });
  test("astra gets a default command WITHOUT evicting sol / luna / terra", () => {
    const names = defaults().map((c) => c.name);
    for (const n of ["astra", "sol", "luna", "terra"]) expect(names).toContain(n);
    expect(defaults().find((c) => c.name === "astra")?.model).toBe("astra");
    // a named product is never a default command
    expect(names).not.toContain("reserve");
    expect(names).not.toContain("auto-review");
  });
});

describe("cached multi-turn conversation on gpt-6-astra", () => {
  const history = [
    { role: "user", text: "My favorite color is teal. Say OK." },
    { role: "assistant", text: "OK." },
    { role: "user", text: "What is my favorite color?" },
  ] as any;
  test("the whole transcript rides one Responses request under one stable cache identity", () => {
    const b = openai.build(astra(), history, { promptCacheKey: "apiplan-chat-42", system: "Answer briefly.", effort: "max" }, CREDS);
    expect(b.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(b.body.model).toBe("gpt-6-astra");
    expect(b.body.store).toBe(false);
    expect(b.body.stream).toBe(true);
    expect(b.body.instructions).toBe("Answer briefly.");
    expect(b.body.reasoning).toEqual({ effort: "max" });
    // cache identity travels in the payload AND in Codex's routing header
    expect(b.body.prompt_cache_key).toBe("apiplan-chat-42");
    expect(b.headers.session_id).toBe("apiplan-chat-42");
    // every prior turn is re-sent in order, in the Responses item shape
    expect(b.body.input.map((i: any) => [i.role, i.content[0].type, i.content[0].text])).toEqual([
      ["user", "input_text", "My favorite color is teal. Say OK."],
      ["assistant", "output_text", "OK."],
      ["user", "input_text", "What is my favorite color?"],
    ]);
    // never a length cap: the codex backend 400s on max_output_tokens
    expect(b.body.max_output_tokens).toBeUndefined();
  });
  test("a second turn on the same key produces the identical prefix (what the cache keys on)", () => {
    const o = { promptCacheKey: "apiplan-chat-42", system: "Answer briefly." };
    const t1 = openai.build(astra(), history.slice(0, 1), o, CREDS);
    const t2 = openai.build(astra(), history, o, CREDS);
    expect(t2.body.instructions).toBe(t1.body.instructions);
    expect(JSON.stringify(t2.body.input.slice(0, 1))).toBe(JSON.stringify(t1.body.input));
    expect(t2.headers.session_id).toBe(t1.headers.session_id);
  });
  test("the cache receipt is read back from the completed response", () => {
    const d = openai.delta({ type: "response.completed", response: { model: "gpt-6-astra",
      usage: { input_tokens: 1247, output_tokens: 10, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 } } } } as any);
    expect(d.usage).toEqual({ input: 1247, output: 10, cacheRead: 1024, cacheWrite: 0 });
  });
  test("--session <key> gives a --chat transcript that identity from the shell", () => {
    const o = parseArgs(["-m", "astra", "--chat", "--session", "shell-thread-7"]);
    expect(o.promptCacheKey).toBe("shell-thread-7");
    expect(o.chat).toBe(true);
    expect(o.prompt).toEqual([]);
    expect(parseArgs(["--cache-key", "k1", "hi"]).promptCacheKey).toBe("k1");
  });
});
