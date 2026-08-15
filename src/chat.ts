// chat.ts — the interactive session you get when you run a command with no prompt.
//
// Deliberately NOT a full-screen TUI. A chat wants scrollback, mouse selection and
// copy-paste, and an alternate-screen buffer takes all three away; every terminal chat
// worth using (claude, codex, aider) streams inline for exactly that reason. So this is
// a line-oriented REPL over node:readline — stdlib, so the zero-dependency promise and
// the startup budget both survive, and line editing plus history come for free.
import { createInterface } from "node:readline";

/** What a chat needs from whoever is answering. Providers and jimmy both fit this. */
export type ChatBackend = {
  /** Shown in the banner, e.g. "Claude Opus 5" or "llama3.1-8B on chatjimmy.ai". */
  label: string;
  /** Stream one reply. Must resolve to the full text, and honour `signal`. */
  send(turns: ChatTurn[], onText: (t: string) => void, signal: AbortSignal): Promise<string>;
  /** Optional footer after each reply — tokens/sec, latency, whatever the backend knows. */
  note?(): string | undefined;
};
export type ChatTurn = { role: "user" | "assistant"; content: string };

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (n: string) => (s: string) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = sgr("2"), bold = sgr("1"), blue = sgr("38;2;150;180;255"), warn = sgr("38;2;225;185;95");

const HELP = `  /clear      forget the conversation so far
  /system …   set a system prompt for the rest of the session
  /retry      ask again, same prompt
  /copy       copy the last reply to the clipboard
  /help       this list
  /exit       leave  (Ctrl-D, or Ctrl-C twice)`;

function copyToClipboard(text: string): boolean {
  const cmd = process.platform === "darwin" ? ["pbcopy"]
    : process.platform === "win32" ? ["clip"]
    : ["xclip", "-selection", "clipboard"];
  try {
    const p = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(text), stderr: "ignore" });
    return p.exitCode === 0;
  } catch { return false }
}

export async function chat(backend: ChatBackend, opts: { system?: string } = {}): Promise<void> {
  const turns: ChatTurn[] = [];
  let system = opts.system;
  let lastReply = "";
  let lastPrompt = "";

  process.stdout.write(`${bold(backend.label)} ${dim("· /help for commands, /exit to leave")}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: blue("› "), historySize: 200 });

  // Ctrl-C cancels the answer in flight; twice in a row (with nothing running) leaves.
  let inFlight: AbortController | null = null;
  let armed = false;
  rl.on("SIGINT", () => {
    if (inFlight) { inFlight.abort(); inFlight = null; return; }
    if (armed) { rl.close(); return; }
    armed = true;
    process.stdout.write(dim("  (Ctrl-C again to exit)\n"));
    rl.prompt();
  });

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    armed = false;
    if (!input) { rl.prompt(); continue }

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "exit": case "quit": case "q": rl.close(); continue;
        case "help": case "?": process.stdout.write(HELP + "\n"); rl.prompt(); continue;
        case "clear": turns.length = 0; process.stdout.write(dim("  conversation cleared\n")); rl.prompt(); continue;
        case "system":
          system = arg || undefined;
          process.stdout.write(dim(arg ? `  system prompt set (${arg.length} chars)\n` : "  system prompt removed\n"));
          rl.prompt(); continue;
        case "copy":
          process.stdout.write(lastReply
            ? (copyToClipboard(lastReply) ? dim("  copied\n") : warn("  no clipboard tool found\n"))
            : dim("  nothing to copy yet\n"));
          rl.prompt(); continue;
        case "retry":
          if (!lastPrompt) { process.stdout.write(dim("  nothing to retry\n")); rl.prompt(); continue }
          // Drop the previous exchange so the retry replaces it rather than stacking.
          if (turns.at(-1)?.role === "assistant") turns.pop();
          if (turns.at(-1)?.role === "user") turns.pop();
          break;
        default:
          process.stdout.write(warn(`  unknown command /${cmd}`) + dim(" — /help\n"));
          rl.prompt(); continue;
      }
    }

    const prompt = input.startsWith("/retry") ? lastPrompt : input;
    lastPrompt = prompt;
    turns.push({ role: "user", content: prompt });

    inFlight = new AbortController();
    let reply = "";
    process.stdout.write("\n");
    try {
      reply = await backend.send(
        system ? [{ role: "user", content: `[system] ${system}` }, ...turns.slice(0, -1), turns.at(-1)!] : turns,
        (t) => { reply += t; process.stdout.write(t); },
        inFlight.signal,
      );
    } catch (e: any) {
      const aborted = inFlight?.signal.aborted || /abort/i.test(e?.message ?? "");
      process.stdout.write(aborted ? dim("\n  stopped\n") : warn(`\n  ${e?.message ?? e}\n`));
      // A failed turn must not poison the history, or every later turn carries it.
      turns.pop();
      inFlight = null;
      rl.prompt();
      continue;
    }
    inFlight = null;

    if (!reply.endsWith("\n")) process.stdout.write("\n");
    const note = backend.note?.();
    if (note) process.stdout.write(dim(`  ${note}\n`));
    process.stdout.write("\n");
    lastReply = reply;
    turns.push({ role: "assistant", content: reply });
    rl.prompt();
  }

  process.stdout.write(dim("\nbye\n"));
}
