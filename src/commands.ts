// commands.ts — the user's set of globally available commands.
//
// ~/.apiplan/commands.json is the single source of truth; the shims on PATH are
// just materialised copies of it. That means renaming or adding a command is a
// config edit plus a re-sync, and `apiplan sync` can always rebuild PATH from scratch.
import { join } from "node:path";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { STATE_DIR, defaultBinDir, readJson, writeJson, writeShim as writeShimTo, removeShim, shadowsExisting, whichSync, isOurShim, IS_WIN } from "./platform.ts";
import { resolve, models, aliasesFor, type Model } from "./registry.ts";
import { PROVIDERS } from "./providers.ts";

export type Command = {
  name: string;
  model: string;          // alias or wire id, resolved at call time so `opus` follows the newest Opus
  flags?: string[];       // baked-in flags, e.g. ["--effort","low","--stream"]
  note?: string;
};
export type Config = { version: 1; binDir?: string; runner?: string; commands: Command[];
  /** Defaults the user removed on purpose — so an upgrade never resurrects them. */
  removed?: string[] };

const FILE = join(STATE_DIR, "commands.json");
export const configPath = () => FILE;

export function load(): Config {
  const c = readJson<Config>(FILE, { version: 1, commands: [] });
  c.commands ??= [];
  return c;
}
export function save(c: Config) { writeJson(FILE, c); }
export const binDirOf = (c: Config) => c.binDir || defaultBinDir();
/** The bun (or compatible) runtime the shims exec. */
export const runnerOf = (c: Config) => c.runner || process.execPath;

/** Providers whose moved variant words get pinned twins (luna6 / luna56). A gateway (zen)
 *  republishes other vendors' lines, so twins there would mint names for someone else's bill. */
const PINNED_TWIN_PROVIDERS: readonly string[] = ["openai"];

/** The default set: one command per model family + per current variant, plus -fast twins. */
export function defaults(): Command[] {
  // "fast" = the least reasoning the provider allows + streaming, so the first token
  // arrives as early as possible. `--thinking off` only means something to Anthropic.
  const fastFlags = (p: string) => (p === "anthropic" ? ["--effort", "low", "--thinking", "off", "--stream"] : ["--effort", "low", "--stream"]);
  const out: Command[] = [];
  const seen = new Set<string>();
  const bin = defaultBinDir();
  const add = (name: string, model: string, flags?: string[], note?: string) => {
    if (seen.has(name)) return;
    // Don't propose a name a real system tool already owns (macOS ships /usr/sbin/gpt).
    // The variant command for that provider still covers it, and on a machine without
    // the clash the name is offered normally — so the default set adapts per platform.
    if (shadowsExisting(name, bin)) return;
    seen.add(name);
    out.push({ name, model, ...(flags ? { flags } : {}), ...(note ? { note } : {}) });
  };
  for (const m of models()) {
    // Website routes are reached as `online/astra` / `online/chat` or `--chatmode` (FALLBACK.online
    // is deliberately route-prefixed); minting `onlinegpt*` commands would put a browser-session
    // route on PATH nobody asked for (observed: mergeDefaults on a real config added 4 of them).
    if (m.provider === "online") continue;
    const fam = m.family;
    // family command → always the newest member of that family
    if (!seen.has(fam)) {
      add(fam, fam, undefined, `newest ${fam}`);
      add(`${fam}-fast`, fam, fastFlags(m.provider), `${fam}, least reasoning + streaming`);
    }
    // A variant gets its own command when this is the NEWEST numbered model carrying that
    // name (astra / sol / luna / terra / mini) — exactly the model `resolve(variant)`
    // answers with. It used to require the provider's newest generation, which the day
    // GPT-6 Astra shipped would have dropped `sol`, `luna` and `terra` from every fresh
    // install while they are still served. Named products (gpt-reserve, codex-auto-review)
    // carry no version and are reachable by exact id / alias, never as a default command.
    if (m.variant && m.version.length && !seen.has(m.variant)
        && models(m.provider).find((x) => x.variant === m.variant && x.version.length)?.id === m.id) {
      add(m.variant, m.variant, undefined, m.label);
    }
  }
  // `spark` — Muse Spark on OpenCode Zen, named EXPLICITLY rather than left to the variant
  // rule above. The rule is right for a vendor's own line-up and wrong for a gateway: it mints
  // a command for the newest NUMBERED model carrying a variant word, and `resolve("spark")` is
  // what a user actually types after reading opencode's docs. Stated here, the command follows
  // resolve() by construction instead of depending on where zen's versions happen to sort.
  // `add()` still refuses to shadow a real tool already on PATH, and still refuses a duplicate,
  // so this is additive in every case.
  // PINNED TWINS — only where a bare variant word has MOVED. The day GPT-6 Luna shipped, `luna`
  // started meaning gpt-6-luna (resolve's newest-first rule); both generations then deserve a
  // name that never moves: luna6 → gpt6luna, luna56 → gpt56luna. A word with one numbered carrier
  // (astra, terra) gets no twin — nothing moved, so a pinned name would be noise on PATH.
  for (const p of PINNED_TWIN_PROVIDERS) {
    const byWord = new Map<string, Model[]>();
    for (const m of models(p as any)) if (m.variant && m.version.length) byWord.set(m.variant, [...(byWord.get(m.variant) ?? []), m]);
    for (const [word, carriers] of byWord) {
      if (carriers.length < 2) continue;
      for (const m of carriers) {
        const v = m.version.join("");
        const target = `${m.family}${v}${word}`;            // gpt6luna / gpt56luna
        if (resolve(target)?.id !== m.id) continue;          // never mint a name that lands elsewhere
        add(`${word}${v}`, target, undefined, `${m.label} (pinned)`);
      }
    }
  }
  if (resolve("spark")) add("spark", "spark", undefined, "Muse Spark on OpenCode Zen");
  // Non-text jobs, named after what they do. Only offered by a provider that can:
  // drawing runs on the OpenAI subscription; speech needs a billed key and says so.
  const drawer = models().find((m) => PROVIDERS[m.provider].canGenerateImages);
  if (drawer) {
    const alias = aliasesFor(drawer)[0] ?? drawer.id;
    add("imagine", alias, ["--draw", "--open"], "generate an image and open it");
    // No `aloud` command: `tts` speaks anything, so read-aloud stopped being the only
    // way to hear something and went back to being a flag (`tts --aloud`). It survives
    // as a flag because the ChatGPT product voices are a different set from realtime's.
    // `tts` is the portable name; `speak` is nicer but espeak-ng already owns it on
    // many machines, so it is offered only where the name is genuinely free.
    add("tts", alias, ["--speak", "--play"], "speak any text on the subscription (--aloud reads a ChatGPT reply)");
    add("speak", alias, ["--speak", "--play"], "same as tts, where the name is free");
  }
  // Dictation — the microphone types. The model alias only picks whose subscription
  // transcribes (the STT engine is the provider's own, not a chat model): `dictation`
  // rides the Claude Code login over the same streaming socket ccvoice dictates
  // through; `dictation-gpt` rides the ChatGPT login over the realtime socket.
  const claude = models().find((m) => m.provider === "anthropic");
  if (claude) add("dictation", aliasesFor(claude)[0] ?? claude.id, ["--dictate"], "speak → text, on the Claude subscription");
  const gpt = models().find((m) => m.provider === "openai");
  if (gpt) add("dictation-gpt", aliasesFor(gpt)[0] ?? gpt.id, ["--dictate"], "speak → text, on the ChatGPT subscription");
  return out;
}

/**
 * Add defaults this config has never seen, leaving everything the user has done alone.
 * Without this an upgrade can add a capability (drawing, read-aloud) that no existing
 * install ever gets a command for — the config was seeded once and frozen forever.
 * A default the user deliberately removed stays removed: `removed` remembers it.
 */
export function mergeDefaults(c: Config): string[] {
  const have = new Set(c.commands.map((x) => x.name));
  const gone = new Set(c.removed ?? []);
  const added: string[] = [];
  for (const d of defaults()) {
    if (have.has(d.name) || gone.has(d.name)) continue;
    c.commands.push(d);
    added.push(d.name);
  }
  return added;
}

/** A default command's note is its model's label ("GPT-5.6-Luna"); when the word moves the note lies.
 *  Rewrites ONLY notes that exactly equal some registry label, on commands whose model is a bare word
 *  with no flags — a note the user wrote by hand is never touched. Returns "name: old → new" lines. */
export function refreshNotes(c: Config): string[] {
  const labels = new Set(models().map((m) => m.label));
  const out: string[] = [];
  for (const cmd of c.commands) {
    if (!cmd.note || !labels.has(cmd.note) || cmd.flags?.length || /\d/.test(cmd.model)) continue;
    const now = resolve(cmd.model)?.label;
    if (now && now !== cmd.note) { out.push(`${cmd.name}: ${cmd.note} → ${now}`); cmd.note = now; }
  }
  return out;
}

export type SyncReport = { written: string[]; skipped: { name: string; why: string }[]; binDir: string };

/**
 * Write a shim for every command in the config. Refuses to shadow an unrelated
 * executable already on PATH (that's how `gpt` silently shadowed macOS's
 * partition-table tool) unless the command is explicitly marked force.
 */
export function sync(c: Config, opts: { force?: boolean; only?: string[]; writeDir?: string } = {}): SyncReport {
  const binDir = binDirOf(c);
  // writeDir: materialise into another directory (the dry run's scratch dir) while every
  // shadow check still asks about the REAL bin dir — so the preview is the real decision.
  const writeShim = (dir: string, name: string, run: string, ent: string, args: string[]) =>
    writeShimTo(opts.writeDir ?? dir, name, run, ent, args).map((f) => (opts.writeDir ? join(binDir, f.slice(opts.writeDir.length + 1)) : f));
  const runner = runnerOf(c);
  const entry = join(import.meta.dir, "..", "bin", "ask.ts");
  const written: string[] = [];
  const skipped: { name: string; why: string }[] = [];
  // `apiplan` itself is always present, so a broken install can always be repaired
  // with the same tool that manages everything else.
  if (!opts.only) written.push(...writeShim(binDir, "apiplan", runner, join(import.meta.dir, "..", "bin", "apiplan.ts"), []));
  if (!opts.only && !shadowsExisting("chatgpt", binDir)) {
    written.push(...writeShim(binDir, "chatgpt", runner, join(import.meta.dir, "..", "bin", "chatgpt.ts"), []));
  }
  // `jimmy` has its own entry point rather than a --model shim: chatjimmy.ai needs no
  // credential and streams raw text, so it shares none of the provider plumbing.
  if (!opts.only && !shadowsExisting("jimmy", binDir)) {
    written.push(...writeShim(binDir, "jimmy", runner, join(import.meta.dir, "..", "bin", "jimmy.ts"), []));
  }
  for (const cmd of c.commands) {
    if (opts.only && !opts.only.includes(cmd.name)) continue;
    const clash = shadowsExisting(cmd.name, binDir);
    if (clash && !opts.force) { skipped.push({ name: cmd.name, why: `would shadow ${clash}` }); continue; }
    if (!resolve(cmd.model)) { skipped.push({ name: cmd.name, why: `unknown model '${cmd.model}'` }); continue; }
    written.push(...writeShim(binDir, cmd.name, runner, entry, ["--model", cmd.model, ...(cmd.flags ?? [])]));
  }
  return { written, skipped, binDir };
}

export type SyncPlan = { add: string[]; change: { name: string; before: string; after: string }[]; same: string[];
  skipped: { name: string; why: string }[]; binDir: string };
/**
 * What `sync` WOULD do, touching nothing: the shims are rendered into a scratch dir by the
 * same code path and compared byte-for-byte with what is on disk now.
 */
export function planSync(c: Config, opts: { force?: boolean; only?: string[] } = {}): SyncPlan {
  const scratch = mkdtempSync(join(tmpdir(), "apiplan-sync-plan-"));
  try {
    const r = sync(c, { ...opts, writeDir: scratch });
    const plan: SyncPlan = { add: [], change: [], same: [], skipped: r.skipped, binDir: r.binDir };
    for (const f of r.written) {
      const rel = f.slice(r.binDir.length + 1);
      const after = readFileSync(join(scratch, rel), "utf8");
      const name = rel.replace(/\.(cmd|ps1)$/, "");
      if (!existsSync(f)) { if (!plan.add.includes(name)) plan.add.push(name); continue; }
      const before = readFileSync(f, "utf8");
      if (before === after) { if (!plan.same.includes(name)) plan.same.push(name); }
      else plan.change.push({ name: rel, before, after });
    }
    plan.same = plan.same.filter((n) => !plan.add.includes(n) && !plan.change.some((x) => x.name.replace(/\.(cmd|ps1)$/, "") === n));
    return plan;
  } finally { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
}

export function add(c: Config, cmd: Command): { ok: boolean; why?: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cmd.name)) return { ok: false, why: "name must start alphanumeric and contain only letters, digits, . _ -" };
  if (c.commands.some((x) => x.name === cmd.name)) return { ok: false, why: `'${cmd.name}' already exists (use rename or rm)` };
  if (!resolve(cmd.model)) return { ok: false, why: `unknown model '${cmd.model}' — see \`apiplan models\`` };
  c.commands.push(cmd);
  return { ok: true };
}
export function rename(c: Config, from: string, to: string): { ok: boolean; why?: string } {
  const cmd = c.commands.find((x) => x.name === from);
  if (!cmd) return { ok: false, why: `no command named '${from}'` };
  if (c.commands.some((x) => x.name === to)) return { ok: false, why: `'${to}' already exists` };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(to)) return { ok: false, why: "invalid name" };
  removeShim(binDirOf(c), from);
  cmd.name = to;
  return { ok: true };
}
export function remove(c: Config, name: string): { ok: boolean; why?: string; removed?: string[] } {
  const i = c.commands.findIndex((x) => x.name === name);
  if (i < 0) return { ok: false, why: `no command named '${name}'` };
  c.commands.splice(i, 1);
  if (defaults().some((d) => d.name === name)) c.removed = [...new Set([...(c.removed ?? []), name])];
  return { ok: true, removed: removeShim(binDirOf(c), name) };
}
/**
 * Shims we wrote that the config no longer knows about — left behind when a command
 * is renamed outside the tool, or by an upgrade that dropped a command. They point at
 * files that may not exist any more, so they are worse than useless.
 */
export function orphans(c: Config): string[] {
  const binDir = binDirOf(c);
  // apiplan and jimmy have their own entry points and are never in commands.json,
  // so without naming them here prune would treat them as leftovers and delete them.
  const keep = new Set<string>(["apiplan", "jimmy", "chatgpt", ...c.commands.map((x) => x.name)]);
  const out: string[] = [];
  try {
    for (const f of require("node:fs").readdirSync(binDir) as string[]) {
      const name = f.replace(/\.(cmd|ps1)$/, "");
      if (keep.has(name)) continue;
      if (isOurShim(join(binDir, f))) out.push(name);
    }
  } catch {}
  return [...new Set(out)];
}
export function prune(c: Config): string[] {
  const gone: string[] = [];
  for (const name of orphans(c)) gone.push(...removeShim(binDirOf(c), name));
  return gone;
}

/** Is this command actually reachable as typed, and does PATH resolve to ours? */
export function health(c: Config, name: string): { installed: boolean; onPath: boolean; resolves: string | null } {
  const binDir = binDirOf(c);
  const files = IS_WIN ? [join(binDir, `${name}.cmd`), join(binDir, `${name}.ps1`)] : [join(binDir, name)];
  const installed = files.some(existsSync);
  const resolves = whichSync(name);
  return { installed, onPath: !!resolves && files.includes(resolves), resolves };
}
