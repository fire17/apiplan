// stream-shape.ts — the two facts about a vendor's STREAM that a reader cannot guess.
//
// Three loops read provider streams (the CLI's consume(), the chat's streamReply(), the
// api server's run()), and all three assumed the same two things: that frames are SSE, and
// that one event is one Delta. Both are true of every subscription vendor here and neither
// is true of a local ollama daemon — its native endpoint frames NDJSON (one JSON object per
// line, no `data:` prefix, no blank-line separator, which an SSE reader sees as ZERO
// events), and one of its events can carry several parallel tool calls.
//
// Rather than teach each loop a vendor, the vendor states its shape and the loops read it
// in one line. A provider that says nothing behaves exactly as before.
import type { Delta, Provider } from "./providers.ts";

/** Optional members a provider may add. Both are additive: absent means the old behaviour. */
export type StreamShape = {
  /** How frames are separated. Absent means "sse". */
  framing?: "sse" | "ndjson";
  /** All the Deltas in one event. Absent means `[delta(ev)]`. */
  deltas?(ev: any): Delta[];
  /**
   * Does this event END the turn? The one fact that separates "the model finished" from
   * "the connection stopped mid-answer" — and a reader that does not ask it treats a
   * truncated body as a complete reply, which is the "it went silent / half an answer"
   * class. Every vendor here answers it; a vendor that does not is simply never checked.
   */
  terminal?(ev: any): boolean;
};
type Shaped = Provider & StreamShape;

/** What separates one frame from the next in this vendor's stream. */
export const frameSep = (p: Provider) => ((p as Shaped).framing === "ndjson" ? "\n" : "\n\n");

/** One raw line → the JSON payload to parse, or "" for a line that carries none. */
export function framePayload(p: Provider, line: string): string {
  if ((p as Shaped).framing === "ndjson") {
    const t = line.trim();
    return t.startsWith("{") ? t : "";
  }
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  return !payload || payload === "[DONE]" ? "" : payload;
}

/**
 * Every Delta in one event. Only a vendor that can batch (ollama, whose parallel tool calls
 * arrive in a single object) implements deltas(); for everyone else this is delta().
 */
export const deltasOf = (p: Provider, ev: any): Delta[] => {
  const many = (p as Shaped).deltas;
  return many ? many.call(p, ev) : [p.delta(ev)];
};

/** Can this vendor's stream be checked for a missing terminator at all? */
export const checkable = (p: Provider) => typeof (p as Shaped).terminal === "function";

/** Did this event terminate the turn? False for a vendor that does not say. */
export const isTerminal = (p: Provider, ev: any): boolean => {
  const t = (p as Shaped).terminal;
  try { return t ? !!t.call(p, ev) : false; } catch { return false; }
};

/** The one sentence every reader reports when a body ends mid-answer. Shared so the CLI,
 *  the chat and the server say the SAME thing about the same fault — a client (or a human)
 *  matching on the wording must not have to know which of the three it is talking to. */
export const truncatedMessage = (p: Provider) =>
  `upstream stream ended without ${p.label}'s end-of-turn event — the reply is INCOMPLETE and must not be treated as finished`;

/** The vendor-neutral fault name carried alongside it. Clients key retry policy off this. */
export const UPSTREAM_TRUNCATED = "upstream_truncated";

/**
 * The end-of-turn watch, in the one place all three stream readers can share it.
 *
 * Three loops read a provider stream — the CLI's consume(), the chat's streamReply() and
 * the server's run() — and "did the vendor actually finish?" is a question each of them
 * must ask, in exactly the same way, or the same upstream cut is an ERROR down one path
 * and a silent half-answer down another. That asymmetry was real: the server learned the
 * check on 2026-08-27 and the CLI did not, so `sol "…"` kept printing half an answer and
 * exiting 0 (and a zero-event cut printed nothing at all, still exiting 0). A watch object
 * rather than a second copy of the predicate is the point: there is one rule, one message,
 * one off-switch, and a reader that forgets to ask cannot compile past `missing()`.
 *
 * Off-switch for a vendor that surprises us in the field: APIPLAN_TRUNCATION_CHECK=0.
 */
export type TerminalWatch = {
  /** Feed every parsed event, in order. Cheap: it stops looking once the turn has ended. */
  see(ev: any): void;
  /** Call once the body has ended: true means the answer is incomplete. */
  missing(): boolean;
  /** What to tell the caller when it is. */
  message(): string;
};
export function watchTerminal(p: Provider): TerminalWatch {
  const want = checkable(p) && process.env.APIPLAN_TRUNCATION_CHECK !== "0";
  let saw = false;
  return {
    see(ev: any) { if (want && !saw && isTerminal(p, ev)) saw = true; },
    missing: () => want && !saw,
    message: () => truncatedMessage(p),
  };
}
