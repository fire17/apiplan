export const meta = {
  name: 'rev-talk-core-semantics',
  description: 'Research exact OpenAI Realtime GA wire semantics needed for tool-calls, barge-in truncate, reconnect/expiry/ping in apiplan talk.ts',
  phases: [
    { title: 'Research', detail: '3 parallel opus-5 lanes: tools · barge-in/cancel · transport (reconnect/expiry/ping)', model: 'opus-5' },
  ],
}

const REPO = '/Users/magic/Creations/APIPlan'

const COMMON = `
You are a READ-ONLY research agent. Do NOT edit any file. Your final text IS the return value.
Context: repo ${REPO}, file src/talk.ts speaks to wss://api.openai.com/v1/realtime?model=gpt-realtime
using the GA (non-beta) event shape — session.update sends { type:"session.update", session:{ type:"realtime",
output_modalities:["audio"], instructions, audio:{ input:{...}, output:{...} } } }. There is NO OpenAI-Beta header
(the beta shape is retired). Read ${REPO}/src/talk.ts and ${REPO}/src/providers.ts first for ground truth.
Also skim ${REPO}/VOICE_UPGRADE_PLAN.md, ${REPO}/DARWIN.md and ${REPO}/CONTINUE.md for prior measured findings.
Web research is allowed and encouraged (WebSearch/WebFetch — load them with ToolSearch first).
Report ONLY things you can cite: a doc URL, a repo file:line, or an explicit "UNVERIFIED — best inference" tag.
Be precise about JSON field names. Never invent a field name that you did not see in a source.
`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'facts', 'uncertainties'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph bottom line' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence', 'confidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'doc URL, or repo file:line, or UNVERIFIED' },
          confidence: { type: 'string', enum: ['verified', 'likely', 'unverified'] },
          json_shape: { type: 'string', description: 'exact JSON payload if applicable, else empty' },
        },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
}

phase('Research')

const LANES = [
  {
    key: 'tools',
    effort: 'xhigh',
    prompt: `${COMMON}
LANE 1 — FUNCTION / TOOL CALLING on the GA realtime API.
Answer exactly:
1. Where do "tools" and "tool_choice" live in the GA session.update payload? Directly on \`session\` (sibling of
   output_modalities / audio), or nested? Give the exact JSON.
2. What is the exact tool definition object shape in GA? (beta used {type:"function", name, description, parameters};
   GA may differ). Give the exact JSON for one tool named "lx" taking {"prompt": string}.
3. Which server events announce a function call, and in what order? Confirm/deny:
   - response.output_item.added with item.type === "function_call"  (carries item.id, item.call_id, item.name)
   - response.function_call_arguments.delta / .done  (carries call_id, name?, arguments as a JSON STRING)
   - response.output_item.done with item.type === "function_call" (carries item.arguments, item.call_id)
   State which of these is the SAFEST single trigger to act on, and whether call_id is present on every one.
4. Exact client payload to return a result:
   conversation.item.create { item: { type: "function_call_output", call_id, output } } — is \`output\` a STRING
   (JSON-encoded) or an object? Is there an outer "item" wrapper? Then response.create — does it need any args?
5. If output_modalities is ["audio"] only, does a tool call still work, and does the follow-up response.create
   need modalities re-specified?
6. Any gotcha about sending session.update with tools mid-conversation (the repo already measured that resending
   turn_detection mid-response ABORTS the response — see VOICE_UPGRADE_PLAN.md). Is sending tools at CONNECT time
   in the same session.update safe?
Return the JSON schema object.`,
  },
  {
    key: 'bargein',
    effort: 'xhigh',
    prompt: `${COMMON}
LANE 2 — BARGE-IN CORRECTNESS (cancel + truncate + stale-delta filtering).
Answer exactly:
1. Exact payload of the client event \`response.cancel\`. Does it take a response_id? Is it optional?
   What server events come back (response.done with status "cancelled"? an error if nothing is in flight?).
2. Exact payload of \`conversation.item.truncate\`: fields item_id, content_index, audio_end_ms. What EXACTLY is
   audio_end_ms measured against — audio the server GENERATED, or audio the client actually PLAYED? What error
   does the server return if audio_end_ms exceeds what was generated? (There is a known
   "audio_end_ms is greater than the actual audio duration" error — confirm the exact behavior and how to avoid it.)
3. What server event carries the assistant ITEM ID that must be truncated? Confirm response.output_item.added
   → ev.item.id, and whether ev.item.type is "message" for audio replies. Is there also a per-response id
   (ev.response_id / ev.response.id) on the audio delta events so stale deltas can be filtered?
4. Do response.output_audio.delta events carry response_id AND item_id? Give the exact field names for the GA
   event (response.output_audio.delta) and the legacy alias (response.audio.delta).
5. Best-practice ordering when the user barges in: cancel-then-truncate or truncate-then-cancel? Any race where
   truncate on an already-completed response errors?
6. If the client never truncates, what exactly goes wrong in the model's context (it believes it said the whole
   thing)? Confirm this is the real bug being fixed.
Return the JSON schema object.`,
  },
  {
    key: 'transport',
    effort: 'xhigh',
    prompt: `${COMMON}
LANE 3 — TRANSPORT: reconnect, session expiry, ping/pong, close codes. Also Bun runtime specifics.
Answer exactly:
1. \`session.created\` — what fields does the GA payload carry? Specifically is there \`expires_at\` (unix SECONDS?)
   and where does it live (ev.session.expires_at)? What is the documented max realtime session lifetime
   (30 min? 60 min?) and what happens at expiry (close code? error event?).
2. Is there ANY server-side session resume / reconnect-with-state for the realtime WS? (The plan asserts NO.)
   Confirm or refute with a citation. If no resume: what is the accepted pattern to carry context across a
   reconnect (replay conversation.item.create messages? a text summary item?). Give the exact JSON for creating
   a plain text context item on a fresh socket:
   conversation.item.create { item: { type: "message", role: "user"|"assistant"|"system", content: [{type:"input_text"|"text", text}] } }
   — which role and which content type are legal for a synthetic context note in GA?
3. WebSocket close codes seen from api.openai.com realtime: which indicate "unexpected drop, retry" vs
   "do not retry" (auth 4401? policy? 1000 normal? 1006 abnormal?). What does rate limiting look like on connect?
4. Bun's WebSocket client: does the \`ws\`-style \`.ping()\` method exist on the global WebSocket returned by
   \`new WebSocket(url, {headers})\` in Bun? Is there a \`pong\` event / \`onpong\`? What is the correct
   feature-detected way to send a keepalive ping, and what is the fallback if .ping is absent
   (a no-op? a zero-length frame? an application-level event)? Check Bun docs/GitHub issues.
   Also: does Bun's WebSocket expose \`bufferedAmount\` and \`terminate()\`? (repo already uses bufferedAmount).
5. Exponential backoff with jitter for reconnects against api.openai.com realtime — any documented rate limits
   on new realtime sessions per minute? (the repo observed flaky connects under rapid reconnect).
Return the JSON schema object.`,
  },
]

const results = await parallel(LANES.map((l) => () =>
  agent(l.prompt, { label: `research:${l.key}`, phase: 'Research', schema: SCHEMA, model: 'opus', effort: l.effort })
))

return LANES.map((l, i) => ({ lane: l.key, result: results[i] }))
