import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";

type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;

type OpenAIChatModelConfig = {
  fetch?: typeof fetch;
};

type ChoiceToolCallState = {
  nextIndex: number;
  byId: Map<string, number>;
  lastIndex?: number;
};

const wrappedFetches = new WeakSet<typeof fetch>();

/**
 * Resolve a built-in Bot's model through the runtime's `resolveModel`, normalizing OpenAI Chat
 * Completions SSE streams whose tool-call deltas omit `index`.
 *
 * WHY. `@ai-sdk/openai`'s `openaiChatChunkSchema` requires `choices[i].index` and
 * `choices[i].delta.tool_calls[j].index` to be numbers. Some OpenAI-compatible Chat Completions
 * endpoints — notably Google's Gemini endpoint (`generativelanguage.googleapis.com/v1beta/openai`)
 * — omit `delta.tool_calls[j].index` on streamed tool calls, causing every tool call (including
 * `render_ui`) to fail Zod validation before the tool executes.
 *
 * HOW. Attach a `fetch` wrapper to resolved `openai.chat` models so `text/event-stream` responses
 * have missing choice / tool-call indices filled deterministically before `@ai-sdk/openai` parses
 * each SSE frame. Compliant streams pass through untouched; non-chat models (OpenAI Responses API,
 * Anthropic, Google native, plan models) are returned as-is.
 */
export function resolveCompatibleModel(
  spec: BuiltInAgentClassicConfig["model"],
  apiKey?: string,
) {
  const model = resolveModel(spec, apiKey);
  normalizeOpenAIChatModel(model);
  return model;
}

/**
 * Wrap a built-in agent configuration's model so OpenAI-compatible Chat Completions streams with
 * missing `delta.tool_calls[].index` pass `@ai-sdk/openai` chunk validation.
 */
export function normalizeOpenAIChatStream(
  configuration: BuiltInAgentConfiguration,
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown;
  try {
    model = resolveCompatibleModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  if (!isModel(model)) return configuration;
  return { ...configuration, model };
}

function normalizeOpenAIChatModel(model: unknown): void {
  if (!isModel(model) || model.provider !== "openai.chat") return;
  const config = (model as { config?: unknown }).config;
  if (!isRecord(config)) return;
  const chatConfig = config as OpenAIChatModelConfig;
  if (chatConfig.fetch && wrappedFetches.has(chatConfig.fetch)) return;
  chatConfig.fetch = wrapChatCompletionsFetch(chatConfig.fetch);
}

function wrapChatCompletionsFetch(baseFetch?: typeof fetch): typeof fetch {
  const wrapped = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    // Resolve globalThis.fetch per call so test stubs installed after model creation still apply.
    const response = await (baseFetch ?? globalThis.fetch)(input, init);
    if (!response.ok || !response.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(normalizeChatCompletionsSse(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }) as typeof fetch;
  wrappedFetches.add(wrapped);
  return wrapped;
}

/**
 * Normalize an OpenAI Chat Completions SSE byte stream so every choice and streamed tool-call delta
 * carries a numeric `index`.
 */
export function normalizeChatCompletionsSse(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decode = new TextDecoder();
  const encode = new TextEncoder();
  const choiceState = new Map<number, ChoiceToolCallState>();
  let buffer = "";
  let rawLines: string[] = [];
  let metaLines: string[] = [];
  let dataLines: string[] = [];

  const flushEvent = (
    controller: TransformStreamDefaultController<Uint8Array>,
    terminatedByBlankLine: boolean,
  ) => {
    if (rawLines.length === 0) {
      if (terminatedByBlankLine) controller.enqueue(encode.encode("\n"));
      return;
    }
    const trailing = terminatedByBlankLine ? "\n\n" : "\n";
    if (dataLines.length === 0) {
      controller.enqueue(encode.encode(`${rawLines.join("\n")}${trailing}`));
      rawLines = [];
      metaLines = [];
      return;
    }
    const payload = dataLines.join("\n");
    const normalized = normalizeChunkPayload(payload, choiceState);
    if (normalized === null) {
      controller.enqueue(encode.encode(`${rawLines.join("\n")}${trailing}`));
    } else {
      const out = [...metaLines, `data: ${normalized}`];
      controller.enqueue(encode.encode(`${out.join("\n")}${trailing}`));
    }
    rawLines = [];
    metaLines = [];
    dataLines = [];
  };

  const processLine = (
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (line === "") {
      flushEvent(controller, true);
      return;
    }
    rawLines.push(line);
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    } else {
      metaLines.push(line);
    }
  };

  const drainLines = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      processLine(line, controller);
      newline = buffer.indexOf("\n");
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decode.decode(chunk, { stream: true });
        drainLines(controller);
      },
      flush(controller) {
        buffer += decode.decode();
        drainLines(controller);
        if (buffer.length > 0) {
          processLine(buffer.replace(/\r$/, ""), controller);
          buffer = "";
        }
        if (rawLines.length > 0) {
          flushEvent(controller, false);
        }
      },
    }),
  );
}

/**
 * Normalize a single SSE `data:` JSON payload in place. Returns the re-serialized JSON string only
 * when a field had to be filled in, or `null` when the payload should be passed through verbatim.
 */
function normalizeChunkPayload(
  payload: string,
  choiceState: Map<number, ChoiceToolCallState>,
): string | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === "[DONE]" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return null;

  let modified = false;
  for (let position = 0; position < parsed.choices.length; position++) {
    const choice = parsed.choices[position];
    if (!isRecord(choice)) continue;
    let choiceIndex: number;
    if (typeof choice.index === "number") {
      choiceIndex = choice.index;
    } else {
      choiceIndex = position;
      choice.index = choiceIndex;
      modified = true;
    }

    const delta = choice.delta;
    if (!isRecord(delta) || !Array.isArray(delta.tool_calls)) continue;

    let state = choiceState.get(choiceIndex);
    if (!state) {
      state = { nextIndex: 0, byId: new Map() };
      choiceState.set(choiceIndex, state);
    }

    for (const call of delta.tool_calls) {
      if (!isRecord(call)) continue;
      const id =
        typeof call.id === "string" && call.id.length > 0 ? call.id : "";
      if (typeof call.index === "number") {
        if (id) state.byId.set(id, call.index);
        state.lastIndex = call.index;
        if (call.index >= state.nextIndex) state.nextIndex = call.index + 1;
        continue;
      }

      let index: number;
      if (id) {
        const existing = state.byId.get(id);
        if (existing !== undefined) {
          index = existing;
        } else {
          index = state.nextIndex++;
          state.byId.set(id, index);
        }
      } else if (
        isRecord(call.function) &&
        typeof call.function.name === "string" &&
        call.function.name.length > 0
      ) {
        index = state.nextIndex++;
      } else {
        index = state.lastIndex ?? state.nextIndex++;
      }
      call.index = index;
      state.lastIndex = index;
      modified = true;
    }
  }

  return modified ? JSON.stringify(parsed) : null;
}

function isModel(model: unknown): model is Model {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
