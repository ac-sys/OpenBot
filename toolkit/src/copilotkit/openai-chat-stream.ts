import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import {
  modelCredits,
  parseLiteLLMResponseCost,
  parseRateLimitHeaders,
} from "./model-credits";

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

const MAX_THOUGHT_SIGNATURES = 2000;
/**
 * Google's official bypass sentinel for replaying historical Gemini 3 tool calls whose original
 * thought signature was not persisted (https://ai.google.dev/gemini-api/docs/thought-signatures).
 */
const SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

const wrappedFetches = new WeakSet<typeof fetch>();
const thoughtSignatures = new Map<string, string>();

function rememberThoughtSignature(toolCallId: string, signature: string): void {
  if (!toolCallId || !signature) return;
  if (thoughtSignatures.has(toolCallId)) {
    thoughtSignatures.delete(toolCallId);
  } else if (thoughtSignatures.size >= MAX_THOUGHT_SIGNATURES) {
    const oldest = thoughtSignatures.keys().next().value;
    if (oldest !== undefined) thoughtSignatures.delete(oldest);
  }
  thoughtSignatures.set(toolCallId, signature);
}

/**
 * Resolve a built-in Bot's model through the runtime's `resolveModel`, normalizing OpenAI Chat
 * Completions streams and requests for OpenAI-compatible providers (such as Google Gemini).
 *
 * WHY.
 * 1. `@ai-sdk/openai`'s `openaiChatChunkSchema` requires `choices[i].index` and
 *    `choices[i].delta.tool_calls[j].index` to be numbers. Some OpenAI-compatible Chat Completions
 *    endpoints (notably `generativelanguage.googleapis.com/v1beta/openai`) omit
 *    `delta.tool_calls[j].index` on streamed tool calls, failing Zod validation before execution.
 * 2. Gemini 3.x models attach an opaque `extra_content.google.thought_signature` to streamed tool
 *    calls and reject multi-turn tool continuations with HTTP 400 if it is not echoed back.
 *    `@ai-sdk/openai` strips `extra_content` when parsing `delta.tool_calls`.
 *
 * HOW. Attach a per-model `fetch` wrapper to resolved `openai.chat` models so:
 * - Incoming `text/event-stream` frames have missing choice/tool-call indices filled deterministically
 *   and any `thought_signature` cached by `tool_call.id` before `@ai-sdk/openai` parses them.
 * - Outgoing Chat Completions requests re-attach cached `extra_content.google.thought_signature`
 *   onto assistant `tool_calls` (falling back to Google's `skip_thought_signature_validator`
 *   sentinel only for Gemini models on older persisted tool calls not in memory).
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
 * Wrap a built-in agent configuration's model so OpenAI-compatible Chat Completions streams and
 * multi-turn Gemini 3 tool calls work cleanly through `@ai-sdk/openai`.
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
    const requestModel =
      init && typeof init.body === "string"
        ? extractRequestModel(init.body)
        : undefined;
    const nextInit =
      init && typeof init.body === "string"
        ? normalizeRequestInit(init, init.body)
        : init;
    // Resolve globalThis.fetch per call so test stubs installed after model creation still apply.
    const response = await (baseFetch ?? globalThis.fetch)(input, nextInit);
    const rateLimit = parseRateLimitHeaders(response.headers);
    const reportedCostUsd = parseLiteLLMResponseCost(response.headers);

    if (!response.ok) {
      if (
        requestModel &&
        (response.status === 429 || response.status === 402)
      ) {
        const snippet = await response
          .clone()
          .text()
          .catch(() => "");
        modelCredits.recordUsage({
          model: requestModel,
          status: response.status,
          rateLimit,
          errorMessage: snippet || response.statusText,
        });
      }
      return response;
    }
    if (!response.body) return response;
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (contentType.includes("text/event-stream")) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(
        normalizeChatCompletionsSse(response.body, (telemetry) => {
          const modelName = telemetry.model ?? requestModel;
          if (!modelName) return;
          modelCredits.recordUsage({
            model: modelName,
            promptTokens: telemetry.promptTokens,
            completionTokens: telemetry.completionTokens,
            totalTokens: telemetry.totalTokens,
            reportedCostUsd,
            status: response.status,
            rateLimit,
          });
        }),
        {
          status: response.status,
          statusText: response.statusText,
          headers,
        },
      );
    }
    if (contentType.includes("application/json")) {
      const text = await response.text();
      captureResponseThoughtSignatures(text);
      const telemetry = extractJsonUsageTelemetry(text);
      const modelName = telemetry.model ?? requestModel;
      if (modelName) {
        modelCredits.recordUsage({
          model: modelName,
          promptTokens: telemetry.promptTokens,
          completionTokens: telemetry.completionTokens,
          totalTokens: telemetry.totalTokens,
          reportedCostUsd,
          status: response.status,
          rateLimit,
        });
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  }) as typeof fetch;
  wrappedFetches.add(wrapped);
  return wrapped;
}

function normalizeRequestInit(
  init: NonNullable<Parameters<typeof fetch>[1]>,
  bodyText: string,
): NonNullable<Parameters<typeof fetch>[1]> {
  const updated = normalizeChatCompletionsRequest(bodyText);
  if (updated === null) return init;
  return { ...init, body: updated };
}

/**
 * Normalize an outgoing Chat Completions JSON request body for Gemini 3 compatibility and latency:
 * - Re-attaches captured `extra_content.google.thought_signature` onto assistant `tool_calls`.
 * - Defaults `reasoning_effort` to `"low"` for Gemini 3 Flash models when the caller left it unset,
 *   keeping interactive tool-calling turns responsive while preserving any explicit user/routine pick.
 */
export function normalizeChatCompletionsRequest(
  bodyText: string,
  signatures: ReadonlyMap<string, string> = thoughtSignatures,
): string | null {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return null;

  let modified = applyThoughtSignatures(parsed, signatures);
  if (applyDefaultGeminiFlashEffort(parsed)) {
    modified = true;
  }
  if (parsed.stream === true && parsed.stream_options === undefined) {
    parsed.stream_options = { include_usage: true };
    modified = true;
  }
  return modified ? JSON.stringify(parsed) : null;
}

function extractRequestModel(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim().length > 0
      ? parsed.model.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

type UsageTelemetry = {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

function extractUsageFields(
  parsed: Record<string, unknown>,
  target: UsageTelemetry,
): void {
  if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
    target.model = parsed.model.trim();
  }
  const usage = parsed.usage;
  if (!isRecord(usage)) return;
  if (typeof usage.prompt_tokens === "number") {
    target.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    target.completionTokens = usage.completion_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    target.totalTokens = usage.total_tokens;
  }
}

function extractJsonUsageTelemetry(bodyText: string): UsageTelemetry {
  const telemetry: UsageTelemetry = {};
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return telemetry;
  try {
    const parsed = JSON.parse(bodyText);
    if (isRecord(parsed)) extractUsageFields(parsed, telemetry);
  } catch {
    // Ignore malformed JSON.
  }
  return telemetry;
}

/**
 * Re-attach captured `extra_content.google.thought_signature` values onto outgoing Chat Completions
 * assistant `tool_calls`. Returns the updated JSON string only when modified, or `null` otherwise.
 */
export function injectThoughtSignatures(
  bodyText: string,
  signatures: ReadonlyMap<string, string> = thoughtSignatures,
): string | null {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return null;
  return applyThoughtSignatures(parsed, signatures)
    ? JSON.stringify(parsed)
    : null;
}

function applyDefaultGeminiFlashEffort(
  parsed: Record<string, unknown>,
): boolean {
  if (parsed.reasoning_effort !== undefined) return false;
  if (typeof parsed.model !== "string") return false;
  if (!/(?:^|\/)gemini-3(?:\.\d+)?-flash(?:-lite)?$/i.test(parsed.model)) {
    return false;
  }
  parsed.reasoning_effort = "low";
  return true;
}

function applyThoughtSignatures(
  parsed: Record<string, unknown>,
  signatures: ReadonlyMap<string, string>,
): boolean {
  if (!Array.isArray(parsed.messages)) return false;
  const isGeminiModel =
    typeof parsed.model === "string" && /gemini/i.test(parsed.model);

  let modified = false;
  for (const message of parsed.messages) {
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.tool_calls)
    ) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      if (extractThoughtSignature(call)) continue;
      const id =
        typeof call.id === "string" && call.id.length > 0 ? call.id : "";
      const signature =
        (id ? signatures.get(id) : undefined) ??
        (isGeminiModel ? SKIP_THOUGHT_SIGNATURE_VALIDATOR : undefined);
      if (!signature) continue;
      const existingExtra = isRecord(call.extra_content)
        ? call.extra_content
        : {};
      const existingGoogle = isRecord(existingExtra.google)
        ? existingExtra.google
        : {};
      call.extra_content = {
        ...existingExtra,
        google: {
          ...existingGoogle,
          thought_signature: signature,
        },
      };
      modified = true;
    }
  }
  return modified;
}

function captureResponseThoughtSignatures(bodyText: string): void {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return;
  for (const choice of parsed.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const calls = choice.message.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const id =
        typeof call.id === "string" && call.id.length > 0 ? call.id : "";
      const signature = extractThoughtSignature(call);
      if (id && signature) rememberThoughtSignature(id, signature);
    }
  }
}

function extractThoughtSignature(call: Record<string, unknown>): string | null {
  const extra = call.extra_content;
  if (isRecord(extra) && isRecord(extra.google)) {
    const sig = extra.google.thought_signature;
    if (typeof sig === "string" && sig.length > 0) return sig;
  }
  const providerFields = call.provider_specific_fields;
  if (isRecord(providerFields)) {
    const direct = providerFields.thought_signature;
    if (typeof direct === "string" && direct.length > 0) return direct;
    if (
      isRecord(providerFields.extra_content) &&
      isRecord(providerFields.extra_content.google)
    ) {
      const nested = providerFields.extra_content.google.thought_signature;
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return null;
}

/**
 * Normalize an OpenAI Chat Completions SSE byte stream so every choice and streamed tool-call delta
 * carries a numeric `index`, while capturing any Gemini `thought_signature` per tool-call id and
 * optional token usage telemetry on stream completion.
 */
export function normalizeChatCompletionsSse(
  body: ReadableStream<Uint8Array>,
  onComplete?: (telemetry: UsageTelemetry) => void,
): ReadableStream<Uint8Array> {
  const decode = new TextDecoder();
  const encode = new TextEncoder();
  const choiceState = new Map<number, ChoiceToolCallState>();
  const telemetry: UsageTelemetry = {};
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
    const normalized = normalizeChunkPayload(payload, choiceState, telemetry);
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
        onComplete?.(telemetry);
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
  telemetry?: UsageTelemetry,
): string | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === "[DONE]" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (telemetry) extractUsageFields(parsed, telemetry);
  if (!Array.isArray(parsed.choices)) return null;

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
      const signature = extractThoughtSignature(call);
      if (id && signature) rememberThoughtSignature(id, signature);
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
