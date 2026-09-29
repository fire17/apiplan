// P3 — the CLI surface on GPT-6: catalog floor + provenance, sync [names] / dry runs,
// doctor --json/--strict, -i on GPT-6, and shell completions. Hermetic subprocess probes only.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sandbox, ASK, AP, ROOT, CODEX_CATALOG, png, shapesPng, type Box } from "./cli-p3-sandbox.ts";

const semver = (v: string) => v.split(".").map(Number);
const leq = (a: string, b: string) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return true; };
function stub() {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/backend-api/codex/models") return new Response("nope", { status: 404 });
    const v = u.searchParams.get("client_version") ?? "0.0.0"; seen.push(v);
    return Response.json({ models: CODEX_CATALOG.models.filter((m: any) => leq(m.minimal_client_version ?? "0.0.0", v)) });
  } });
  return { seen, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
const snap = (b: Box) => [b.state, b.bin].flatMap((d) => readdirSync(d).sort().map((f) => {
  const p = join(d, f); return `${p} ${createHash("sha1").update(readFileSync(p)).digest("hex")} ${statSync(p).mtimeMs}`; }));
const doctorJson = (b: Box, extra: string[] = [], env: Record<string, string> = {}) => {
  const r = b.run(AP, ["doctor", "--json", ...extra], env);
  return { ...r, j: JSON.parse(r.out) as { version: string; rows: { key: string; state: string; detail: string }[]; problems: number } };
};
const row = (j: any, key: string) => j.rows.find((r: any) => r.key === key);

// ── catalog floor + provenance ────────────────────────────────────────────────
test("catalog is fetched as a client that sees GPT-6 Sol/Luna, and the version is recorded", async () => {
  const s = stub();
  try {
    const b = sandbox({ catalog: null });
    const p = Bun.spawn([process.execPath, AP, "models", "--refresh", "--provider", "openai"], { env: { ...b.env, APIPLAN_OPENAI_BASE: s.base }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(); await p.exited;
    // seen = [probe (far-future, learn only), final]; the FINAL ask is what is stored.
    expect(s.seen.length).toBeGreaterThan(0);
    const final = s.seen.at(-1)!;
    expect(leq("0.155.0", final)).toBe(true);
    const ids = JSON.parse(readFileSync(join(b.state, "models.openai.json"), "utf8")).models.map((m: any) => m.id);
    expect(ids).toContain("gpt-6-sol"); expect(ids).toContain("gpt-6-luna");
    const meta = JSON.parse(readFileSync(join(b.state, "models.openai.meta.json"), "utf8"));
    expect(meta.client_version).toBe(final); expect(meta.live).toBe(true);
    expect(out).toContain("live Codex catalog");
  } finally { s.stop(); }
});

test("env override still wins upward", async () => {
  const s = stub();
  try {
    const b = sandbox({ catalog: null });
    const p = Bun.spawn([process.execPath, AP, "models", "--refresh", "--provider", "openai"], { env: { ...b.env, APIPLAN_OPENAI_BASE: s.base, APIPLAN_CODEX_CLIENT_VERSION: "0.200.0", APIPLAN_CODEX_CATALOG_PROBE: "0" }, stdout: "pipe", stderr: "pipe" });
    await p.exited;
    expect(s.seen).toEqual(["0.200.0"]);
  } finally { s.stop(); }
});

// ── sync / install previews ───────────────────────────────────────────────────
test("sync <name> writes only that shim, bound to the word (not the id)", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }, { name: "sol", model: "sol" }] });
  const r = b.run(AP, ["sync", "luna"]);
  expect(r.code).toBe(0);
  expect(existsSync(join(b.bin, "luna"))).toBe(true);
  expect(existsSync(join(b.bin, "sol"))).toBe(false);
  expect(existsSync(join(b.bin, "apiplan"))).toBe(false);
  const shim = readFileSync(join(b.bin, "luna"), "utf8");
  expect(shim).toContain("--model luna"); expect(shim).not.toContain("gpt-6-luna");
});

test("sync of an unknown name says so and exits 1", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  const r = b.run(AP, ["sync", "nope"]);
  expect(r.out).toContain("no command named nope");
  expect(r.code).toBe(1);
  expect(readdirSync(b.bin)).toEqual([]);
});

test("install --dry-run and sync --dry-run write nothing and show the diff", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  b.run(AP, ["sync", "luna"]);
  writeFileSync(join(b.bin, "luna"), "#!/bin/sh\nexec old\n");
  const before = snap(b);
  const i = b.run(AP, ["install", "--dry-run"]);
  expect(i.code).toBe(0);
  expect(i.out).toContain("would add:");
  expect(i.out).toMatch(/luna6[\s\S]*luna56|luna56[\s\S]*luna6/);
  const s = b.run(AP, ["sync", "--dry-run"]);
  expect(s.code).toBe(0);
  expect(s.out).toContain("changed:   luna");
  expect(s.out).toContain("- exec old");
  expect(s.out).toContain("--model luna");
  expect(snap(b)).toEqual(before);
});

// ── doctor ────────────────────────────────────────────────────────────────────
test("doctor --json names the GPT-6 rows", () => {
  const b = sandbox({ meta: { client_version: "0.155.0", live: true, fetched_at: Date.now() } });
  const { code, j } = doctorJson(b);
  expect(code).toBe(0);
  expect(row(j, "catalog openai").state).toBe("ok");
  expect(row(j, "gpt-6 lineup").state).toBe("ok");
  expect(row(j, "gpt-6 lineup").detail).toContain("gpt-6-astra, gpt-6-sol, gpt-6-luna");
  expect(row(j, "image input").state).toBe("ok");
  expect(row(j, "aliases").detail).toContain("luna→gpt-6-luna");
  expect(row(j, "aliases").detail).toContain("sol→gpt-6-sol");
});

test("doctor warns on a catalog fetched below the floor, or of unknown provenance", () => {
  const low = doctorJson(sandbox({ meta: { client_version: "0.153.4", live: true } })).j;
  expect(row(low, "catalog openai").state).toBe("warn");
  expect(row(low, "catalog openai").detail).toContain("below floor");
  const none = doctorJson(sandbox({})).j;
  expect(row(none, "catalog openai").state).toBe("warn");
  expect(row(none, "catalog openai").detail).toContain("client version unknown");
  const old = doctorJson(sandbox({ catalog: "2026-09-15", meta: { client_version: "0.155.0", live: true } })).j;
  expect(row(old, "aliases").detail).toContain("luna→gpt-5.6-luna");
});

test("a command whose model no longer resolves is flagged", () => {
  const { j } = doctorJson(sandbox({ commands: [{ name: "ghost", model: "gpt9zzz" }] }));
  expect(row(j, "cmd ghost").state).toBe("warn");
  expect(row(j, "cmd ghost").detail).toContain("no longer resolves");
});

test("--strict exits 1 only on a red row; plain doctor stays 0", () => {
  const b = sandbox({});
  const absent = { APIPLAN_CODEX_AUTH: join(b.dir, "absent.json") };
  expect(doctorJson(b, ["--strict"], absent).code).toBe(1);
  expect(b.run(AP, ["doctor"], absent).code).toBe(0);
  expect(b.run(AP, ["doctor"], absent).out).toContain("DOCTOR");
});

// ── -i on GPT-6 ───────────────────────────────────────────────────────────────
test("-i reaches GPT-6 as input_image (png and jpeg), and a tiny image is refused", () => {
  const b = sandbox({});
  const pngFile = join(b.dir, "shapes.png"); writeFileSync(pngFile, shapesPng());
  const r = b.run(ASK, ["--model", "luna6", "--dry-run", "-e", "low", "-i", pngFile, "what is this"]);
  expect(r.code).toBe(0);
  const body = JSON.parse(r.out).body;
  expect(body.model).toBe("gpt-6-luna");
  const content = body.input[0].content;
  expect(content[1].type).toBe("input_image");
  expect(content[1].image_url.startsWith("data:image/png;base64,")).toBe(true);
  const tiny = join(b.dir, "tiny.png"); writeFileSync(tiny, png(4, 4, () => [0, 0, 0]));
  const t = b.run(ASK, ["--model", "luna", "--dry-run", "-i", tiny, "x"]);
  expect(t.code).toBe(1);
  expect(t.err + t.out).toMatch(/too small/i);
});

// ── completions ───────────────────────────────────────────────────────────────
const lines = (s: string) => s.split("\n").filter(Boolean);
test("__complete models knows the GPT-6 names, and every one resolves", () => {
  const b = sandbox({});
  const r = b.run(AP, ["__complete", "models"]);
  expect(r.code).toBe(0);
  const names = lines(r.out);
  for (const n of ["luna", "sol", "gpt6luna", "gpt56luna", "gpt-6-luna", "luna6", "luna56", "sol6", "sol56", "online/astra"]) expect(names).toContain(n);
  for (const n of ["luna6", "sol56", "gpt6sol", "astra", "terra", "gpt-5.5", "opus", "haiku", "flash", "gpt"]) {
    if (names.includes(n)) expect(b.run(ASK, ["--model", n, "--dry-run", "x"]).code).toBe(0);
  }
});

test("efforts follow the bound model", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  const e = lines(b.run(AP, ["__complete", "efforts", "luna"]).out);
  for (const x of ["low", "medium", "high", "xhigh", "max"]) expect(e).toContain(x);
  expect(lines(b.run(AP, ["__complete", "efforts", "x", "gpt-5.5"]).out)).not.toContain("max");
});

test("completion scripts are valid shell", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }, { name: "luna6", model: "gpt6luna" }] });
  for (const [sh, check] of [["zsh", ["zsh", "-n"]], ["bash", ["/bin/bash", "-n"]], ["fish", ["fish", "-n"]]] as const) {
    if (!Bun.which(check[0])) continue;
    const r = b.run(AP, ["completions", sh]);
    expect(r.code).toBe(0);
    const f = join(b.dir, `c.${sh}`); writeFileSync(f, r.out);
    const c = Bun.spawnSync([...check, f], { stdout: "pipe", stderr: "pipe" });
    expect([sh, c.exitCode, c.stderr.toString()]).toEqual([sh, 0, ""]);
  }
});

test("bash completes GPT-6 model names after -m (macOS bash 3.2)", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  expect(b.run(AP, ["sync"]).code).toBe(0); // puts the box's own `apiplan` shim on the box PATH
  const c = Bun.spawnSync(["/bin/bash", "-c", 'eval "$(apiplan completions bash)"; COMP_WORDS=(luna -m gpt6); COMP_CWORD=2; _apiplan_ask_complete; printf "%s\\n" "${COMPREPLY[@]}"'],
    { env: b.env, stdout: "pipe", stderr: "pipe" });
  expect(lines(c.stdout.toString()).sort()).toEqual(["gpt6astra", "gpt6luna", "gpt6sol"]);
});

test("every parseArgs flag is completable", () => {
  const src = readFileSync(join(ROOT, "src", "engine.ts"), "utf8");
  const i = src.indexOf("export function parseArgs");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  const flags = [...new Set([...body.matchAll(/case "(-{1,2}[\w-]+)"/g)].map((m) => m[1]))];
  expect(flags.length).toBeGreaterThan(20);
  const got = new Set(lines(sandbox({}).run(AP, ["__complete", "flags"]).out));
  expect(flags.filter((f) => !got.has(f))).toEqual([]);
});

test("__complete is pure, and an unknown kind is empty with exit 0", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  const before = snap(b);
  for (const k of [["models"], ["efforts", "luna"], ["commands"], ["flags"], ["providers"], ["zzz"]]) {
    const r = b.run(AP, ["__complete", ...k]);
    expect(r.code).toBe(0);
    if (k[0] === "zzz") expect(r.out).toBe("");
  }
  expect(snap(b)).toEqual(before);
});

test("unknown shell is refused", () => {
  const r = sandbox({}).run(AP, ["completions", "tcsh"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: apiplan completions zsh|bash|fish");
});

test("shell-init carries the completion; bash still has no aliases", () => {
  const b = sandbox({ commands: [{ name: "luna", model: "luna" }] });
  const z = b.run(AP, ["shell-init", "zsh"]).out;
  expect(z).toContain("compdef _apiplan apiplan");
  expect(z).toContain("(( $+functions[compdef] ))");
  const bb = b.run(AP, ["shell-init", "bash"]).out;
  expect(bb).not.toMatch(/^alias /m);
  expect(bb).toContain("complete -o default -F _apiplan_complete apiplan");
});
