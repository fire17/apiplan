/**
 * A BYTE-STABLE ~8k-token request fixture, for probing prompt-cache behaviour.
 *
 * WHY THIS EXISTS. Prompt caching can only be measured by sending the SAME bytes twice and
 * reading the raw counters back. Every earlier attempt in this repo hand-rolled its body
 * inside a throwaway script, and two of them silently failed for the same two reasons:
 *
 *   · the prompt was too SMALL. OpenAI's implicit prefix cache has a 1024-token floor and
 *     reports at an eligibility boundary, so a ~2k probe cannot distinguish "the reusable
 *     prefix is capped at the tools block" from "the prefix is the whole prompt" — both
 *     land within noise of each other. The default here is sized so the tools block and the
 *     whole prompt are FAR apart (see SIZES), which is what makes the two answers separable.
 *   · the body was not actually stable. A `Date.now()`, a `randomUUID()`, a re-serialised
 *     object with different key order, or a turn counter that advanced with the loop index
 *     all change the bytes, and a changed prefix is indistinguishable from a cache that does
 *     not work. Everything below is a pure function of its arguments: no clock, no randomness,
 *     no ambient state. `probeBodyJson` emits the keys in a fixed order, so two calls with
 *     equal arguments are equal BYTE FOR BYTE — assert it with `sha256` before you spend a
 *     paid call on a conclusion.
 *
 * SHAPE. The body deliberately mirrors what a real Claude-Code-style client sends through
 * this proxy's Anthropic front, because that is the path under test: a `system` ARRAY whose
 * first block may be the request-bound billing attestation, a tools block, alternating
 * user/assistant turns with `role:"developer"` system-reminders wedged between them, a
 * stable `metadata.user_id` carrying the cache identity, and `output_config.effort`.
 *
 * EFFORT IS PART OF THE PREFIX. A request-level reasoning-effort change resets the cached
 * prefix upstream, so `effort` defaults to a fixed value and must be held CONSTANT across
 * every call of an arm — varying it invalidates the experiment rather than the cache.
 *
 * COSTS NOTHING BY ITSELF. This module builds objects and strings. It opens no socket, reads
 * no credential and touches no file; the caller decides whether anything is ever sent.
 */

/** One tool, in the Anthropic wire spelling the proxy's Anthropic front accepts. */
export type ProbeTool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
};

/** An Anthropic-dialect `system` block. */
export type ProbeSystemBlock = { type: "text"; text: string };

/** An Anthropic-dialect message. `developer` is what a system-reminder rides in on. */
export type ProbeMessage = {
  role: "user" | "assistant" | "developer";
  content: { type: "text"; text: string }[];
};

/** The request body. Key order here IS the serialised key order — see probeBodyJson. */
export type ProbeBody = {
  model: string;
  max_tokens: number;
  stream: boolean;
  output_config: { effort: string };
  system: ProbeSystemBlock[];
  messages: ProbeMessage[];
  tools: ProbeTool[];
  metadata: { user_id: string };
};

/**
 * The sixteen tool names, fixed and ordered. Sixteen because that is the order of magnitude
 * a real agent harness ships, and because the tools block is the specific prefix segment
 * under suspicion: OpenAI renders context as hidden-system -> TOOLS -> instructions ->
 * history, so a volatile head-of-instructions caps the reusable prefix at exactly this
 * block. An experiment that wants to see that cap needs the block to be big and constant.
 */
export const PROBE_TOOL_NAMES: readonly string[] = [
  "read", "write", "edit", "bash", "glob", "grep", "task", "hub",
  "web_search", "eval", "yield", "debug", "browser", "slider", "ast_edit", "report_issue",
] as const;

/**
 * One sentence of filler, repeated to reach a target size. It is deliberately prose rather
 * than a random blob: a tokenizer splits realistic English at a realistic ~4 chars/token,
 * so the character budget below predicts the token count instead of drifting from it.
 */
const FILLER =
  "This tool performs one documented deterministic operation on the workspace, validates its arguments before acting, and never varies between invocations. ";

/**
 * Repeat counts tuned so the default fixture lands near 8k tokens AND keeps the tools block
 * and the whole prompt far apart — 6680 vs 8007, a 1327-token gap. That gap is the entire
 * point: a cache_read landing on one number rather than the other is what distinguishes
 * "the reusable prefix is capped at the tools block" from "the whole prompt is reusable",
 * and the earlier ~2k probes could not separate the two. MEASURED with tiktoken o200k_base
 * (the GPT-5.6/6 family encoding) on 2026-09-06 — see SIZES.
 * Changing either constant changes the fixture's identity; re-measure if you do.
 */
const TOOL_DESCRIPTION_REPEAT = 14;
const SYSTEM_FILLER_REPEAT = 39;

/**
 * The invariant instruction paragraph: the segment that a caller's volatile attestation sits
 * in FRONT of. Its content is irrelevant to the measurement; its byte-stability is the point.
 * The first line keeps the reply short so a probe cannot accidentally spend output tokens.
 */
export const PROBE_SYSTEM_TEXT: string =
  "You are a cache-probe fixture. Reply with exactly one short word and nothing else.\n" +
  ("Invariant standing operating policy paragraph which is identical on every single turn and exists only to occupy a stable, cacheable region of the prompt prefix. "
    .repeat(SYSTEM_FILLER_REPEAT));

/**
 * Claude Code's request-bound billing attestation line, as it arrives on the wire.
 *
 * The `cch` field hashes the ORIGINAL request body, so a real client's value differs on
 * every turn — which is exactly the churn under investigation. Pass a FIXED value to hold
 * the head of the instructions constant, or a varying one to reproduce the churn.
 */
export function billingAttestation(cch: number | string): string {
  const n = typeof cch === "number" ? String(cch).padStart(5, "0") : cch;
  return `x-anthropic-billing-header: cc_version=2.1.246; cch=${n};`;
}

/** The sixteen tools. A pure function of its arguments: same input, same bytes. */
export function probeTools(
  count: number = PROBE_TOOL_NAMES.length,
  descriptionRepeat: number = TOOL_DESCRIPTION_REPEAT,
): ProbeTool[] {
  return PROBE_TOOL_NAMES.slice(0, count).map((name) => ({
    name,
    description: `${name}: ${FILLER.repeat(descriptionRepeat)}`,
    input_schema: {
      type: "object" as const,
      properties: {
        i: { type: "string", description: "A short statement of intent for this invocation." },
        path: { type: "string", description: "The workspace-relative path this call operates on." },
        body: { type: "string", description: "The payload this call writes, when it writes one." },
      },
      required: ["i"],
    },
  }));
}

/**
 * The conversation body: `cycles` user/assistant pairs, each followed by a positional
 * system-reminder, then one closing user turn. Every string is derived from the loop index,
 * so a given `cycles` always produces the same bytes.
 */
export function probeMessages(cycles: number): ProbeMessage[] {
  const messages: ProbeMessage[] = [];
  for (let i = 0; i < cycles; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `request ${i}: continue the standing task` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `working ${i}` }] });
    messages.push({ role: "developer", content: [{ type: "text", text: `<system-reminder>workspace state unchanged after step ${i}</system-reminder>` }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: `turn ${cycles}: answer in one word` }] });
  return messages;
}

export type ProbeBodyOptions = {
  /** Cache identity. The proxy forwards it as prompt_cache_key and the session_id header. */
  key: string;
  /**
   * The attestation's `cch`. A number or string puts the attestation at system[0]; `null`
   * omits the block entirely, which is the clean control arm.
   */
  cch?: number | string | null;
  /** User/assistant cycles before the closing turn. Fixed within an arm. */
  cycles?: number;
  /** Pass [] for the no-tools arm — the control that isolates the tools block. */
  tools?: ProbeTool[];
  model?: string;
  /** Small on purpose: a probe measures the PROMPT, and output tokens are not free. */
  maxTokens?: number;
  /** Hold this CONSTANT across an arm: a change resets the cached prefix upstream. */
  effort?: string;
  stream?: boolean;
};

/**
 * The default arm shape. Anything not named is fixed, because an experiment's controls must
 * be defaults rather than something each caller remembers to pass.
 */
export function probeBody(o: ProbeBodyOptions): ProbeBody {
  const cch = o.cch ?? null;
  const system: ProbeSystemBlock[] = [];
  if (cch !== null) system.push({ type: "text", text: billingAttestation(cch) });
  system.push({ type: "text", text: PROBE_SYSTEM_TEXT });
  return {
    model: o.model ?? "gpt-6-astra",
    max_tokens: o.maxTokens ?? 16,
    stream: o.stream ?? true,
    output_config: { effort: o.effort ?? "low" },
    system,
    messages: probeMessages(o.cycles ?? 2),
    tools: o.tools ?? probeTools(),
    metadata: { user_id: o.key },
  };
}

/**
 * The body as the bytes that go on the wire. `probeBody` builds its object literal in one
 * fixed key order and JSON.stringify preserves insertion order, so this is canonical:
 * equal arguments give an identical string, and its sha256 is the fixture's identity.
 * Re-serialising a body that came from anywhere else is NOT guaranteed to match.
 */
export function probeBodyJson(o: ProbeBodyOptions): string {
  return JSON.stringify(probeBody(o));
}

/** Character sizes of each prefix segment — the free, tokenizer-independent sanity check. */
export function probeSizes(o: ProbeBodyOptions = { key: "sizing" }): {
  toolsChars: number; systemChars: number; messagesChars: number; bodyChars: number;
} {
  const b = probeBody(o);
  return {
    toolsChars: JSON.stringify(b.tools).length,
    systemChars: JSON.stringify(b.system).length,
    messagesChars: JSON.stringify(b.messages).length,
    bodyChars: JSON.stringify(b).length,
  };
}

/**
 * Token sizes of the default fixture, MEASURED with tiktoken o200k_base on 2026-09-06 and
 * recorded here so a later reader can see what the constants were tuned to without paying
 * for a call or installing a tokenizer. Re-measure if the constants above change.
 *
 * `toolsTokens` is the number a cache_read would report if the reusable prefix ends at the
 * tools block; `totalTokens` is what it would report if the whole prompt is reusable. They
 * are 1327 apart on purpose — an observed counter can only be near one of them.
 */
export const SIZES = {
  encoding: "o200k_base",
  measuredAt: "2026-09-06",
  toolsTokens: 6680,
  systemTokens: 1149,
  messagesTokens: 178,
  totalTokens: 8007,
} as const;
