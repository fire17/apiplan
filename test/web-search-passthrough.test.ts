// web-search-passthrough.test.ts — a hosted web_search tool reaches the Codex backend (2026-10-16,
// agent:sharoni: Living Atlas needs real initiatives with source URLs, not remembered ones).
import { expect, test, describe } from "bun:test";
import { responsesToChat, optsFrom, webSearchTool } from "../src/api.ts";
import { openai, anthropic } from "../src/providers.ts";
import { resolve } from "../src/registry.ts";

describe("webSearchTool — Chat's web_search_options → the Responses tool", () => {
  test("empty options are a plain web_search tool", () => {
    expect(webSearchTool({})).toEqual({ type: "web_search" });
  });
  test("Chat's nested approximate location is flattened; context size kept", () => {
    expect(webSearchTool({ search_context_size: "high", user_location: { type: "approximate", approximate: { country: "IL", city: "Tel Aviv" } } }))
      .toEqual({ type: "web_search", search_context_size: "high", user_location: { type: "approximate", country: "IL", city: "Tel Aviv" } });
  });
  test("absent or malformed is no tool", () => {
    expect(webSearchTool(undefined)).toBeUndefined();
    expect(webSearchTool("yes")).toBeUndefined();
    expect(webSearchTool([])).toBeUndefined();
  });
});

describe("the Responses route carries web_search through to the openai build", () => {
  const chat = responsesToChat({ model: "luna", input: "find it", tools: [{ type: "web_search", search_context_size: "low" }, { type: "function", name: "f", parameters: {} }] });
  test("responsesToChat keeps it as web_search_options beside the function tools", () => {
    expect(chat.web_search_options).toEqual({ search_context_size: "low" });
    expect(chat.tools.map((t: any) => t.function.name)).toEqual(["f"]);
  });
  test("optsFrom turns it into a hosted tool, and the openai build sends it", () => {
    const o = optsFrom(chat);
    expect(o.hostedTools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    const b = openai.build(resolve("gpt-6-luna")!, [{ role: "user", text: "find it" }], o, { token: "t", source: "x" });
    expect(b.body.tools).toContainEqual({ type: "web_search", search_context_size: "low" });
  });
  test("web_search_preview is accepted as the same tool", () => {
    expect(responsesToChat({ model: "luna", input: "x", tools: [{ type: "web_search_preview" }] }).web_search_options).toEqual({});
  });
  test("no web_search tool → nothing added", () => {
    const o = optsFrom(responsesToChat({ model: "luna", input: "x" }));
    expect(o.hostedTools).toBeUndefined();
    expect(openai.build(resolve("gpt-6-luna")!, [{ role: "user", text: "x" }], o, { token: "t", source: "x" }).body.tools).toBeUndefined();
  });
  test("a non-openai backend ignores it, as before", () => {
    const o = optsFrom({ web_search_options: {} });
    const b = anthropic.build(resolve("haiku")!, [{ role: "user", text: "x" }], o, { token: "t", source: "x" } as any);
    expect(JSON.stringify(b.body)).not.toContain("web_search");
  });
});
