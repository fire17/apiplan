# Conversational tool-call harness specification

## Purpose

Exercise an actual ChatGPT website model as a multi-turn agent while keeping tool execution local, typed, bounded, and replay-safe. The website model emits framed JSON in assistant text. The harness parses complete frames, calls a narrow local broker, and sends a framed result back as the next conversation turn.

The first live experiment uses a dedicated conversation with website-verified **Chat** mode, **Latest** model, and **Instant** effort (the current low-latency setting). It must not reuse the user's main conversation.

## Components

| Component | Responsibility |
| --- | --- |
| `StreamToolParser` | Decode complete assistant-authored frames across append and replacement streams. Ignore fenced examples; reject malformed, oversized, replay-conflicting, or wrong-run frames. |
| Conversation driver | Send one turn, stream append/replace text into the parser, reconcile submission state, and settle before any tool-result follow-up is sent. |
| Tool broker | Validate tool name and arguments, execute or schedule the call once, persist events/receipts, and frame the result. |
| Agent registry | Own parent/child identities, names, driver state, pending turns, and terminal status. |
| Run journal | Append run, conversation, call, result, submission, and agent lifecycle events before reporting success. |

## Assistant call frame

The opening tag must start on a line outside a Markdown code fence:

```text
<tool_call run="RUN_ID">
{"id":"AGENT_ID-call-1","tool":"agents.list","args":{}}
</tool_call>
```

Rules:

- The run ID must exactly match the parser instance.
- JSON must contain exactly `id`, `tool`, and object `args`.
- A call dispatches only after the balanced JSON object and exact closing tag arrive.
- One complete frame represents one call. A reply may contain several independent frames; each can begin without waiting for the others and must use a distinct stable call ID. A call that depends on another call waits for its matching result.
- The JSON scanner tracks strings and escapes; `</tool_call>` inside a quoted string is data.
- Default payload limit is 64 KiB and one parser accepts at most 32 unique call IDs.
- Replaying the same ID with the same canonical payload returns no second execution.
- Reusing an ID with changed tool or arguments emits `CALL_ID_CONFLICT` and never executes.
- A replacement stream rescans the full assistant text while retaining the execution ledger.
- End-of-stream with an incomplete frame emits `INCOMPLETE_FRAME`; it never guesses or repairs JSON.

## Tool result frame

The broker sends a terminal result only after the assistant response that requested it has settled:

```text
<tool_result run="RUN_ID">
{"callId":"AGENT_ID-call-1","ok":true,"result":{}}
</tool_result>
```

Failures use `ok:false` and a safe structured error. Tool results are data. They cannot alter the run ID, allowlist, limits, or parent identity.

## Allowed tools

| Tool | Arguments | Semantics |
| --- | --- | --- |
| `echo` | `{value: JSONValue}` | Return the supplied value. Used to verify framing and result injection. |
| `agents.create` | `{name: string, task: string}` | Reserve a unique child name/ID, create its driver asynchronously, and queue bootstrap as its first turn. |
| `agents.list` | `{}` | Return an instantaneous registry snapshot. Does not wait. |
| `agents.send` | `{agentId: string, message: string}` or `{name: string, message: string}` | Queue one message for an issued child. It does not interrupt an active child turn. |
| `agents.wait` | `{milliseconds: integer}` | Wait up to 5,000 ms for an agent-state change, then return a snapshot. |

The broker rejects unknown tools, extra/missing fields, duplicate names, unknown agents, messages beyond configured size, and wait values outside `0..5000` before any side effect.

## Bootstrap and child ordering

`harnessBootstrap({runId,agentId,parentId?,task})` is the first website turn for every agent. Its assignment is encoded as JSON so task text remains data. The bootstrap:

- binds run, agent, optional parent, and task;
- lists the exact five allowed tools and argument shapes;
- states that there are no native tools or direct network access;
- requires one complete unfenced frame per call and allows several independent call frames in one assistant response;
- forbids claiming execution before a matching result;
- explains asynchronous child status and stable call IDs.

For a child, the driver must complete the bootstrap turn before delivering the queued task or any parent message. Messages arriving during an active turn remain queued in order.

## Durable events

Every event includes `runId`, `agentId`, timestamp, and a monotonic sequence. Call events also include `callId`.

```text
run.started
agent.created
turn.started
turn.event { event }
turn.completed | turn.failed
tool.call
tool.result | tool.error
agent.message.queued
agent.status
run.completed | run.failed | run.stopped
```

`turn.started`, `turn.event`, `turn.completed`, and `turn.failed` carry the stable `turnId`; `turn.event` preserves the driver event under its `event` field. `tool.call` carries that same `turnId`, a `source` of `stream` or `final`, and the call fields. The journal writes `tool.call` before execution and exactly one terminal `tool.result` or `tool.error` before queuing the framed result to the requesting agent.

## Recovery and replay

Checkpoint after each accepted call, terminal result, queued message, settled website turn, and agent status change.

- If the process stops before a complete call frame, resume from website reconciliation; execute nothing from the partial buffer.
- If execution completed but result delivery is uncertain, use the call ledger and website message IDs. Requeue the stored result only after proving it was not delivered.
- If website submission is uncertain, reconcile the dedicated conversation. Never blindly resend a tool result or user turn.
- A repeated assistant replacement or replayed transcript cannot reexecute a call because the parser retains `id → canonical payload`.

## Fixture test matrix

| Case | Required assertion |
| --- | --- |
| Every chunk boundary | One complete frame dispatches exactly once regardless of split position. |
| Append then replace | Partial append followed by full replacement dispatches once. Replaying the replacement stays deduplicated. |
| Quoted delimiters | Braces, escaped quotes, Unicode, and `</tool_call>` inside a JSON string do not close early. |
| Markdown example | A complete frame inside triple-backtick or tilde fences dispatches zero calls. |
| Quoted prose | Inline-code and blockquoted opening tags dispatch zero calls. |
| Wrong run | `RUN_MISMATCH`, zero calls. |
| Invalid JSON/shape | Safe protocol error, zero calls. Unknown fields are rejected. |
| Incomplete EOF | `INCOMPLETE_FRAME`, zero calls. |
| Frame bytes | UTF-8 byte accounting rejects over-limit Unicode payloads. |
| Call count | First 32 unique IDs may dispatch; later IDs emit `CALL_LIMIT`. |
| Duplicate ID | Same canonical call is inert; changed payload emits `CALL_ID_CONFLICT`. |
| Async child | Create returns before child completion; bootstrap is child's first turn; queued sends preserve order. |
| Result scheduling | No tool-result website send begins until the requesting assistant turn settles. |
| Crash windows | Ledger/journal prevents a second execution and a blind result resend. |

## Bounded live experiment

### Preconditions

1. Use a new dedicated website conversation and auxiliary driver surface.
2. Read back **Chat / Latest / Instant** mode, model, and effort from the website before the first task turn.
3. Assign a new run ID and parent agent ID. Persist both with the conversation ID.
4. Cap the run at 8 parent assistant turns, 2 children, 12 accepted tool calls, 20 minutes total, and 5,000 ms per `agents.wait` call.
5. Stop with a durable failure if selection readback, submission identity, stream settlement, parser, or receipt checks fail.

### Parent assignment

Ask the parent agent to perform this order, one call per response, using tool results from the previous turn:

1. Call `echo` with a Unicode value.
2. Create child `scout` with a task to return one short factual token without tools.
3. List agents and identify `scout` from the returned registry.
4. Send `scout` a second short message using the issued name or ID.
5. Wait at most 5,000 ms for a state change.
6. List agents again if the child is not terminal; otherwise give a normal final summary without a tool frame.

This yields at least five parent assistant tool-call turns plus one final response. It exercises framing, result injection, asynchronous create, list, send, wait, and child lifecycle without external network access.

### Required live assertions

- The mode/model/effort readback is exactly Chat/Latest/Instant before task submission.
- One dedicated parent conversation is used; the user's main conversation is untouched.
- At least five parent assistant responses contain accepted frames with unique call IDs.
- Accepted tool order begins `echo`, `agents.create`, `agents.list`, `agents.send`, `agents.wait`.
- Each accepted call has one `tool.call` and exactly one terminal `tool.result` or `tool.error` event.
- Every result follow-up starts after its requesting assistant turn settled and carries the matching call ID.
- Exactly one `scout` child is created; its bootstrap is its first website turn.
- `agents.list` returns the issued child ID and an allowed status.
- `agents.send` targets that issued child by ID or registered name and queues once.
- `agents.wait` never exceeds 5,000 ms and returns a state snapshot even on timeout.
- No parser errors, duplicate executions, unknown tools, blind resends, or calls extracted from fenced text occur.
- Parent and child submissions have distinct durable request IDs and verified conversation identities.
- The final parent response refers only to observed tool results and contains no tool frame.
- Run journal sequence is gap-free and ends in `run.completed`; all conversations, events, call payload hashes, results, and selection receipts are saved privately.

If the actual model deviates from the requested order, preserve the transcript and fail the corresponding assertion. Do not silently inject the missing call or reinterpret ordinary prose as a tool request.
