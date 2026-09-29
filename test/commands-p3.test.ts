// P3 — commands follow GPT-6: pinned generation twins, no website-route commands, notes that
// stop lying when a word moves. Every probe is a subprocess in a hermetic sandbox.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, ROOT, ASK, AP, type Box } from "./cli-p3-sandbox.ts";

const defaultsIn = (b: Box): { name: string; model: string; note?: string }[] => {
  const p = Bun.spawnSync([process.execPath, "-e", `import {defaults} from "${join(ROOT, "src", "commands.ts")}"; console.log(JSON.stringify(defaults()))`],
    { env: b.env, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  return JSON.parse(p.stdout.toString());
};
const bodyModel = (b: Box, model: string) => {
  const r = b.run(ASK, ["--model", model, "--dry-run", "hi"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).body.model as string;
};

test("pinned twins exist only where a variant moved", () => {
  const d = defaultsIn(sandbox({ catalog: "gpt6" }));
  const pick = (n: string) => d.find((c) => c.name === n)?.model;
  expect(pick("luna6")).toBe("gpt6luna");
  expect(pick("luna56")).toBe("gpt56luna");
  expect(pick("sol6")).toBe("gpt6sol");
  expect(pick("sol56")).toBe("gpt56sol");
  for (const n of ["astra6", "terra56", "reserve", "gptreserve"]) expect(pick(n)).toBeUndefined();
});

test("no twins when nothing moved (pre-GPT-6-Sol/Luna catalog)", () => {
  const d = defaultsIn(sandbox({ catalog: "2026-09-15" }));
  expect(d.filter((c) => /^(luna|sol|astra|terra)\d+$/.test(c.name)).map((c) => c.name)).toEqual([]);
});

test("every twin lands on exactly its generation", () => {
  const b = sandbox({ catalog: "gpt6" });
  const want: Record<string, string> = { luna6: "gpt-6-luna", luna56: "gpt-5.6-luna", sol6: "gpt-6-sol", sol56: "gpt-5.6-sol" };
  for (const c of defaultsIn(b).filter((c) => c.name in want)) expect(bodyModel(b, c.model)).toBe(want[c.name]);
});

test("website routes never become default commands", () => {
  const d = defaultsIn(sandbox({ catalog: "gpt6" }));
  expect(d.filter((c) => c.name.startsWith("online")).map((c) => c.name)).toEqual([]);
});

test("refreshNotes (via install --dry-run) touches only label-shaped notes and writes nothing", () => {
  const b = sandbox({ catalog: "gpt6", commands: [
    { name: "luna", model: "luna", note: "GPT-5.6-Luna" },
    { name: "mine", model: "luna", note: "my vision cmd" },
    { name: "luna-x", model: "luna", flags: ["-e", "low"], note: "GPT-5.6-Luna" },
  ] });
  const before = readFileSync(join(b.state, "commands.json"), "utf8");
  const r = b.run(AP, ["install", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("would re-label luna: GPT-5.6-Luna → GPT-6-Luna");
  expect(r.out).not.toContain("would re-label mine");
  expect(r.out).not.toContain("would re-label luna-x");
  expect(readFileSync(join(b.state, "commands.json"), "utf8")).toBe(before);
});

test("variant words follow GPT-6; explicit generations stay put", () => {
  const b = sandbox({ catalog: "gpt6" });
  const want: Record<string, string> = { luna: "gpt-6-luna", sol: "gpt-6-sol", astra: "gpt-6-astra", gpt: "gpt-6-astra",
    codex: "gpt-6-astra", terra: "gpt-5.6-terra", gpt56luna: "gpt-5.6-luna", gpt6luna: "gpt-6-luna" };
  for (const [alias, id] of Object.entries(want)) expect([alias, bodyModel(b, alias)]).toEqual([alias, id]);
});
