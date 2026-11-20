import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyModelTier,
  estimateUsageCostUsd,
  fetchLiveProviderBalance,
  ModelCreditsLedger,
  parseRateLimitHeaders,
} from "../src/copilotkit/model-credits";
import {
  normalizeChatCompletionsRequest,
  normalizeChatCompletionsSse,
} from "../src/copilotkit/openai-chat-stream";

let tempFile: string | null = null;

afterEach(() => {
  if (tempFile) {
    rmSync(tempFile, { force: true });
    tempFile = null;
  }
});

describe("model-credits", () => {
  test("classifies local Ollama aliases separately from metered online models", () => {
    expect(classifyModelTier("local-fast")).toBe("local");
    expect(classifyModelTier("local-smart")).toBe("local");
    expect(classifyModelTier("ollama_chat/qwen2.5:3b")).toBe("local");
    expect(classifyModelTier("qwen2.5:7b")).toBe("local");

    expect(classifyModelTier("gemini-3.5-flash-lite")).toBe("online");
    expect(classifyModelTier("gemini-3.8-flash")).toBe("online");
    expect(classifyModelTier("gemini-3.1-pro-preview")).toBe("online");
    expect(classifyModelTier("groq-llama-70b")).toBe("online");
  });

  test("estimates online USD spend from tokens and prefers explicit LiteLLM response cost", () => {
    // 1M input ($0.10) + 500k output ($0.20) on gemini-3.5-flash-lite = $0.30
    expect(
      estimateUsageCostUsd("gemini-3.5-flash-lite", 1_000_000, 500_000),
    ).toEqual({ costUsd: 0.3, pricingKnown: true });

    // Local models always cost $0
    expect(estimateUsageCostUsd("local-fast", 100_000, 50_000)).toEqual({
      costUsd: 0,
      pricingKnown: true,
    });

    // Gateway-reported positive cost overrides reference table
    expect(
      estimateUsageCostUsd("gemini-3.5-flash-lite", 1000, 500, 0.012345),
    ).toEqual({ costUsd: 0.012345, pricingKnown: true });
  });

  test("tracks remaining online credits, persists across reloads, raises low/429 alerts, and resets cleanly", () => {
    tempFile = path.join(
      os.tmpdir(),
      `openbot-credits-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const ledger = new ModelCreditsLedger(tempFile);
    ledger.setBudgetUsd(1.0);

    // Local call should not consume online credits
    ledger.recordUsage({
      model: "local-fast",
      promptTokens: 5000,
      completionTokens: 500,
      status: 200,
    });

    // Online call: 2M input ($0.20) + 1.625M output ($0.65) = $0.85 -> $0.15 remaining (15% -> low-credit alert)
    ledger.recordUsage({
      model: "gemini-3.5-flash-lite",
      promptTokens: 2_000_000,
      completionTokens: 1_625_000,
      status: 200,
    });

    // Reload from disk to verify persistence
    const reloaded = new ModelCreditsLedger(tempFile);
    const snap = reloaded.snapshot({
      BOT_MODEL: "gemini-3.5-flash-lite",
      ROUTER_MODEL: "local-fast",
      GOOGLE_API_KEY: "test-key",
    });

    expect(snap.online.budgetUsd).toBe(1);
    expect(snap.online.totalSpendUsd).toBe(0.85);
    expect(snap.online.remainingUsd).toBe(0.15);
    expect(snap.online.percentRemaining).toBe(15);
    expect(snap.online.quotaAlert).toContain("Low online credits");
    expect(snap.local.totalRequests).toBe(1);
    expect(snap.local.totalTokens).toBe(5500);
    expect(snap.systemModels.routerModel).toBe("local-fast");

    // HTTP 429 quota error surfaces as immediate alert
    reloaded.recordUsage({
      model: "gemini-3.5-flash-lite",
      status: 429,
      errorMessage: "RESOURCE_EXHAUSTED",
    });
    const after429 = reloaded.snapshot({ GOOGLE_API_KEY: "test-key" });
    expect(after429.online.quotaAlert).toContain("HTTP 429");

    // Reset clears usage while keeping configured budget
    reloaded.resetUsage();
    const afterReset = reloaded.snapshot({ GOOGLE_API_KEY: "test-key" });
    expect(afterReset.online.budgetUsd).toBe(1);
    expect(afterReset.online.totalSpendUsd).toBe(0);
    expect(afterReset.online.remainingUsd).toBe(1);
    expect(afterReset.byModel).toEqual([]);
  });

  test("parses provider rate-limit headers and OpenRouter live credit balance", async () => {
    const headers = new Headers({
      "x-ratelimit-remaining-requests": "48",
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-tokens": "120000",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-reset-requests": "12s",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      remainingRequests: 48,
      limitRequests: 50,
      remainingTokens: 120000,
      limitTokens: 200000,
      resetRequests: "12s",
    });

    const live = await fetchLiveProviderBalance(
      { OPENROUTER_API_KEY: "or-key" },
      (async () =>
        new Response(
          JSON.stringify({ data: { total_credits: 25, total_usage: 6.25 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    );
    expect(live?.provider).toBe("OpenRouter");
    expect(live?.remainingUsd).toBe(18.75);
    expect(live?.totalCreditsUsd).toBe(25);
  });

  test("requests streaming usage telemetry and captures SSE usage chunks", async () => {
    const req = JSON.stringify({
      model: "gemini-3.5-flash-lite",
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    });
    const updated = normalizeChatCompletionsRequest(req);
    expect(updated).not.toBeNull();
    expect(JSON.parse(updated ?? "{}").stream_options).toEqual({
      include_usage: true,
    });

    const encode = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encode.encode(
            `data: ${JSON.stringify({
              model: "gemini-3.5-flash-lite",
              choices: [{ index: 0, delta: { content: "Hello" } }],
            })}\n\ndata: ${JSON.stringify({
              model: "gemini-3.5-flash-lite",
              choices: [],
              usage: {
                prompt_tokens: 42000,
                completion_tokens: 180,
                total_tokens: 42180,
              },
            })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });

    let captured: {
      model?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    } | null = null;
    const normalized = normalizeChatCompletionsSse(stream, (t) => {
      captured = t;
    });
    const reader = normalized.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(captured).toEqual({
      model: "gemini-3.5-flash-lite",
      promptTokens: 42000,
      completionTokens: 180,
      totalTokens: 42180,
    });
  });
});
