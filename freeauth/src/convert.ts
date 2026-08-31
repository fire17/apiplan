// convert.ts — OpenAI Chat Completions ⇄ Responses API. Pure functions, no I/O.
// The Codex backend speaks Responses (streaming only); most apps speak Chat Completions.

type Msg = { role: string; content: any; name?: string; tool_calls?: any[]; tool_call_id?: string };

/** One chat `content` (string or parts) → Responses input parts. */
function parts(content: any, role: string): any[] | string {
  if (typeof content === "string" || content == null) return content ?? "";
  const textType = role === "assistant" ? "output_text" : "input_text";
  return content.map((p: any) => {
    if (p.type === "text") return { type: textType, text: p.text };
    if (p.type === "image_url") return { type: "input_image", image_url: p.image_url?.url ?? p.image_url, detail: p.image_url?.detail ?? "auto" };
    return p;
  });
}

/** Chat Completions request body → Responses request body (what the Codex endpoint wants). */
export function chatToResponses(c: any): any {
  const sys: string[] = [];
  const input: any[] = [];
  for (const m of c.messages as Msg[]) {
    if (m.role === "system" || m.role === "developer") { sys.push(typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("")); continue; }
    if (m.role === "tool") { input.push({ type: "function_call_output", call_id: m.tool_call_id, output: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }); continue; }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) input.push({ role: "assistant", content: parts(m.content, "assistant") });
      for (const t of m.tool_calls) input.push({ type: "function_call", call_id: t.id, name: t.function.name, arguments: t.function.arguments ?? "{}" });
      continue;
    }
    input.push({ role: m.role, content: parts(m.content, m.role) });
  }
  const body: any = { model: c.model, instructions: sys.join("\n\n"), input, store: false, stream: true };
  if (c.tools?.length) body.tools = c.tools.map((t: any) => t.type === "function"
    ? { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: t.function.strict ?? false }
    : t);
  if (c.tool_choice) body.tool_choice = typeof c.tool_choice === "object" && c.tool_choice.function ? { type: "function", name: c.tool_choice.function.name } : c.tool_choice;
  if (c.parallel_tool_calls !== undefined) body.parallel_tool_calls = c.parallel_tool_calls;
  if (c.reasoning_effort) body.reasoning = { effort: c.reasoning_effort };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.response_format?.type === "json_schema") body.text = { format: { type: "json_schema", ...c.response_format.json_schema } };
  else if (c.response_format?.type === "json_object") body.text = { format: { type: "json_object" } };
  // max_tokens deliberately dropped: the Codex backend rejects max_output_tokens (400).
  return body;
}

/**
 * Stateful translator: feed Responses SSE events, get Chat Completions chunks out.
 * Tracks tool-call indices the way clients expect (index per call, id+name on first delta).
 */
export function chunker(id: string, model: string, created: number) {
  const calls = new Map<string, number>(); // item_id → tool_calls index
  let served = model, finish: string | null = null, usage: any = null;
  const chunk = (delta: any, finish_reason: string | null = null, extra: any = {}) =>
    ({ id, object: "chat.completion.chunk", created, model: served, choices: [{ index: 0, delta, finish_reason }], ...extra });
  return {
    get finish() { return finish; }, get usage() { return usage; }, get model() { return served; },
    /** Returns zero or more chunks for one upstream event. */
    feed(ev: any): any[] {
      switch (ev.type) {
        case "response.created": served = ev.response?.model ?? served; return [chunk({ role: "assistant", content: "" })];
        case "response.output_text.delta": return [chunk({ content: ev.delta ?? "" })];
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": return [chunk({ reasoning_content: ev.delta ?? "" })];
        case "response.output_item.added":
          if (ev.item?.type === "function_call") {
            const idx = calls.size; calls.set(ev.item.id, idx);
            return [chunk({ tool_calls: [{ index: idx, id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: "" } }] })];
          }
          return [];
        case "response.function_call_arguments.delta": {
          const idx = calls.get(ev.item_id); if (idx === undefined) return [];
          return [chunk({ tool_calls: [{ index: idx, function: { arguments: ev.delta ?? "" } }] })];
        }
        case "response.completed": case "response.incomplete": {
          const r = ev.response ?? {};
          served = r.model ?? served;
          finish = calls.size ? "tool_calls" : r.status === "incomplete" ? "length" : "stop";
          if (r.usage) usage = { prompt_tokens: r.usage.input_tokens ?? 0, completion_tokens: r.usage.output_tokens ?? 0, total_tokens: r.usage.total_tokens ?? 0 };
          return [chunk({}, finish, usage ? { usage } : {})];
        }
        default: return [];
      }
    },
  };
}

/** Fold a stream of chat chunks into one non-streaming chat.completion object. */
export function foldChat(chunks: any[]): any {
  let content = "", reasoning = "", finish = "stop", usage: any = undefined, model = "";
  const tools: any[] = [];
  for (const c of chunks) {
    model = c.model ?? model;
    const d = c.choices?.[0]?.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const t of d.tool_calls ?? []) {
      tools[t.index] ??= { id: t.id, type: "function", function: { name: t.function?.name ?? "", arguments: "" } };
      if (t.id) tools[t.index].id = t.id;
      if (t.function?.name) tools[t.index].function.name = t.function.name;
      tools[t.index].function.arguments += t.function?.arguments ?? "";
    }
    if (c.choices?.[0]?.finish_reason) finish = c.choices[0].finish_reason;
    if (c.usage) usage = c.usage;
  }
  const first = chunks[0] ?? {};
  const message: any = { role: "assistant", content: content || (tools.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.length) message.tool_calls = tools;
  return { id: first.id, object: "chat.completion", created: first.created, model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}
