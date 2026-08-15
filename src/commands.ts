// commands.ts — the user's set of globally available commands.
//
// ~/.apiplan/commands.json is the single source of truth; the shims on PATH are
// just materialised copies of it. That means renaming or adding a command is a
// config edit plus a re-sync, and `apiplan sync` can always rebuild PATH from scratch.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { STATE_DIR, defaultBinDir, readJson, writeJson, writeShim, removeShim, shadowsExisting, whichSync, isOurShim, IS_WIN } from "./platform.ts";
import { resolve, models, aliasesFor } from "./registry.ts";
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
    const fam = m.family;
    // family command → always the newest member of that family
    if (!seen.has(fam)) {
      add(fam, fam, undefined, `newest ${fam}`);
      add(`${fam}-fast`, fam, fastFlags(m.provider), `${fam}, least reasoning + streaming`);
    }
    // current-generation variants get their own command (sol / luna / terra)
    if (m.variant && m.version.join("") === models(m.provider)[0].version.join("")) {
      add(m.variant, m.variant, undefined, m.label);
    }
  }
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

export type SyncReport = { written: string[]; skipped: { name: string; why: string }[]; binDir: string };

/**
 * Write a shim for every command in the config. Refuses to shadow an unrelated
 * executable already on PATH (that's how `gpt` silently shadowed macOS's
 * partition-table tool) unless the command is explicitly marked force.
 */
export function sync(c: Config, opts: { force?: boolean; only?: string[] } = {}): SyncReport {
  const binDir = binDirOf(c);
  const runner = runnerOf(c);
  const entry = join(import.meta.dir, "..", "bin", "ask.ts");
  const written: string[] = [];
  const skipped: { name: string; why: string }[] = [];
  // `apiplan` itself is always present, so a broken install can always be repaired
  // with the same tool that manages everything else.
  if (!opts.only) written.push(...writeShim(binDir, "apiplan", runner, join(import.meta.dir, "..", "bin", "apiplan.ts"), []));
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
  const keep = new Set<string>(["apiplan", "jimmy", ...c.commands.map((x) => x.name)]);
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
