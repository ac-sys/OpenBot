import { afterEach, describe, expect, test } from "bun:test";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import {
  injectThoughtSignatures,
  normalizeChatCompletionsRequest,
  normalizeChatCompletionsSse,
  resolveCompatibleModel,
} from "../src/copilotkit/openai-chat-stream";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encode = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encode.encode(chunk));
      }
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function parseSseData(text: string): unknown[] {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
}

describe("normalizeChatCompletionsSse", () => {
  test("adds missing delta.tool_calls[].index on Gemini-shaped tool call chunks", async () => {
    const geminiChunk = {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments:
                    '{"target":"chat","operations":[{"version":"1.0","createSurface":{"surfaceId":"weekend_budget"}}]}',
                  name: "render_ui",
                },
                id: "function-call-14332201355333059378",
                type: "function",
              },
            ],
          },
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
      created: 1795086500,
      id: "oNj-ar7jH7rtkdUP9ZTjuAo",
      model: "gemini-2.5-flash",
      object: "chat.completion.chunk",
      usage: {
        completion_tokens: 154,
        prompt_tokens: 43057,
        total_tokens: 43509,
      },
    };
    const out = await readStream(
      normalizeChatCompletionsSse(
        sseStream([`data: ${JSON.stringify(geminiChunk)}\n\ndata: [DONE]\n\n`]),
      ),
    );
    const [parsed] = parseSseData(out) as [
      { choices: [{ delta: { tool_calls: [{ index: number; id: string }] } }] },
    ];
    expect(parsed.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(parsed.choices[0].delta.tool_calls[0].id).toBe(
      "function-call-14332201355333059378",
    );
    expect(out).toContain("data: [DONE]");
  });

  test("assigns distinct indices for parallel and sequential tool calls without index", async () => {
    const chunk1 = {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                id: "function-call-1",
                type: "function",
                function: { name: "first", arguments: '{"a":1}' },
              },
              {
                id: "function-call-2",
                type: "function",
                function: { name: "second", arguments: '{"b":2}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const chunk2 = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "function-call-3",
                type: "function",
                function: { name: "third", arguments: '{"c":3}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const out = await readStream(
      normalizeChatCompletionsSse(
        sseStream([
          `data: ${JSON.stringify(chunk1)}\n\n`,
          `data: ${JSON.stringify(chunk2)}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const events = parseSseData(out) as Array<{
      choices: [
        { delta: { tool_calls: Array<{ index: number; id: string }> } },
      ];
    }>;
    expect(events[0]?.choices[0].delta.tool_calls.map((c) => c.index)).toEqual([
      0, 1,
    ]);
    expect(events[1]?.choices[0].delta.tool_calls.map((c) => c.index)).toEqual([
      2,
    ]);
  });

  test("reuses the active index across streamed argument continuations", async () => {
    const start = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call-a",
                type: "function",
                function: { name: "lookup", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const contWithSameId = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call-a",
                function: { arguments: '"hello' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const contWithoutId = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                function: { arguments: '"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const out = await readStream(
      normalizeChatCompletionsSse(
        sseStream([
          `data: ${JSON.stringify(start)}\n\n`,
          `data: ${JSON.stringify(contWithSameId)}\n\n`,
          `data: ${JSON.stringify(contWithoutId)}\n\n`,
        ]),
      ),
    );
    const events = parseSseData(out) as Array<{
      choices: [{ delta: { tool_calls: Array<{ index: number }> } }];
    }>;
    expect(events.map((e) => e.choices[0].delta.tool_calls[0]?.index)).toEqual([
      0, 0, 0,
    ]);
  });

  test("defaults missing choice.index and handles arbitrary chunk boundaries", async () => {
    const raw = `: keepalive\n\nevent: message\ndata: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "ping", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    // Split every 7 characters so lines and JSON payloads break across chunks.
    const pieces: string[] = [];
    for (let i = 0; i < raw.length; i += 7) {
      pieces.push(raw.slice(i, i + 7));
    }
    const out = await readStream(
      normalizeChatCompletionsSse(sseStream(pieces)),
    );
    expect(out).toContain(": keepalive");
    expect(out).toContain("event: message\n");
    const [event] = parseSseData(out) as [
      {
        choices: [
          { index: number; delta: { tool_calls: [{ index: number }] } },
        ];
      },
    ];
    expect(event.choices[0].index).toBe(0);
    expect(event.choices[0].delta.tool_calls[0].index).toBe(0);
  });

  test("passes compliant chunks, errors, and non-JSON frames through verbatim", async () => {
    const compliant =
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"error":{"message":"rate limited"}}\n\n' +
      "data: not-json\n\n" +
      "data: [DONE]\n\n";
    const out = await readStream(
      normalizeChatCompletionsSse(sseStream([compliant])),
    );
    expect(out).toBe(compliant);
  });
});

describe("BuiltInAgentWithSaneHistory on an endpoint that omits delta.tool_calls[].index", () => {
  const savedBaseUrl = process.env.OPENAI_BASE_URL;
  const savedApi = process.env.COPILOTKIT_OPENAI_API;
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(async () => {
    if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseUrl;
    if (savedApi === undefined) delete process.env.COPILOTKIT_OPENAI_API;
    else process.env.COPILOTKIT_OPENAI_API = savedApi;
    await server?.stop(true);
    server = undefined;
  });

  test("executes a streamed Gemini tool call and completes the turn without type validation failure", async () => {
    let callCount = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        callCount += 1;
        if (callCount === 1) {
          const toolChunk = {
            choices: [
              {
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"city":"Paris"}',
                        name: "lookup_weather",
                      },
                      id: "function-call-14332201355333059378",
                      type: "function",
                    },
                  ],
                },
                finish_reason: "tool_calls",
                index: 0,
              },
            ],
            created: 1795086500,
            id: "oNj-ar7jH7rtkdUP9ZTjuAo",
            model: "gemini-2.5-flash",
            object: "chat.completion.chunk",
          };
          return new Response(
            `data: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]\n\n`,
            {
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            },
          );
        }
        const textChunk = {
          choices: [
            {
              delta: { role: "assistant", content: "It is sunny in Paris." },
              finish_reason: "stop",
              index: 0,
            },
          ],
          created: 1795086501,
          id: "oNj-ar7jH7rtkdUP9ZTjuAp",
          model: "gemini-2.5-flash",
          object: "chat.completion.chunk",
        };
        return new Response(
          `data: ${JSON.stringify(textChunk)}\n\ndata: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        );
      },
    });

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.COPILOTKIT_OPENAI_API = "chat";

    const executed: unknown[] = [];
    const configuration = {
      model: "openai/gemini-2.5-flash",
      apiKey: "synthetic-gemini-key",
      prompt: "Be helpful.",
      maxSteps: 4,
      tools: [
        {
          name: "lookup_weather",
          description: "Look up weather.",
          parameters: z.object({ city: z.string() }),
          execute: async (args: unknown) => {
            executed.push(args);
            return { forecast: "sunny" };
          },
        },
      ],
    } as BuiltInAgentConfiguration;

    const agent = new BuiltInAgentWithSaneHistory(configuration, {
      inline: async (messages) => messages,
      observe: (events) => events,
    });
    agent.addMessage({
      id: "m1",
      role: "user",
      content: "What is the weather in Paris?",
    });

    await agent.runAgent();

    expect(callCount).toBe(2);
    expect(executed).toEqual([{ city: "Paris" }]);
    expect(agent.messages.at(-1)?.content).toBe("It is sunny in Paris.");
  });

  test("handles a client-side render_ui tool call and a pre-resolved model wrapped by resolveCompatibleModel", async () => {
    const renderUiArgs = JSON.stringify({
      target: "chat",
      operations: [
        {
          version: "1.0",
          createSurface: {
            components: [
              {
                id: "root",
                children: ["budget_breakdown"],
                title: "Weekend Trip Budget",
                component: "Card",
              },
            ],
            dataModel: { items: [{ amount: 100, label: "Transport" }] },
            surfaceId: "weekend_budget",
          },
        },
      ],
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        const chunk = {
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: renderUiArgs,
                      name: "render_ui",
                    },
                    id: "function-call-14332201355333059378",
                    type: "function",
                  },
                ],
              },
              finish_reason: "tool_calls",
              index: 0,
            },
          ],
          created: 1795086500,
          id: "oNj-ar7jH7rtkdUP9ZTjuAo",
          model: "gemini-2.5-flash",
          object: "chat.completion.chunk",
          usage: {
            completion_tokens: 154,
            prompt_tokens: 43057,
            total_tokens: 43509,
          },
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        );
      },
    });

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.COPILOTKIT_OPENAI_API = "chat";

    const inner = resolveCompatibleModel(
      "openai/gemini-2.5-flash",
      "synthetic-gemini-key",
    );
    // Simulate a wrapper like `withToolSearch` that hides the underlying OpenAI model behind a v3 façade.
    const facade = {
      specificationVersion: "v3" as const,
      provider: inner.provider,
      modelId: inner.modelId,
      supportedUrls: inner.supportedUrls,
      doGenerate: (options: Parameters<typeof inner.doGenerate>[0]) =>
        inner.doGenerate(options),
      doStream: (options: Parameters<typeof inner.doStream>[0]) =>
        inner.doStream(options),
    };

    const agent = new BuiltInAgentWithSaneHistory(
      {
        model: facade,
        prompt: "Be helpful.",
      } as BuiltInAgentConfiguration,
      {
        inline: async (messages) => messages,
        observe: (events) => events,
      },
    );
    agent.addMessage({
      id: "m1",
      role: "user",
      content: "Draw a weekend trip budget.",
    });

    await agent.runAgent({
      tools: [
        {
          name: "render_ui",
          description: "Render a UI surface.",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const assistant = agent.messages.find(
      (message) =>
        message.role === "assistant" &&
        "toolCalls" in message &&
        Array.isArray(message.toolCalls) &&
        message.toolCalls.length > 0,
    );
    expect(assistant).toBeDefined();
    if (assistant && "toolCalls" in assistant) {
      expect(assistant.toolCalls?.[0]?.id).toBe(
        "function-call-14332201355333059378",
      );
      expect(assistant.toolCalls?.[0]?.function.name).toBe("render_ui");
      expect(assistant.toolCalls?.[0]?.function.arguments).toBe(renderUiArgs);
    }
  });

  test("round-trips Gemini 3 thought_signature across multi-step tool calls", async () => {
    const expectedSig = "EnsKeQFpFH0T-synthetic-thought-signature";
    let step = 0;
    let receivedStep2Sig: unknown;

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        step += 1;
        const body = (await request.json()) as {
          messages?: Array<{
            role?: string;
            tool_calls?: Array<{
              id?: string;
              extra_content?: { google?: { thought_signature?: string } };
            }>;
          }>;
        };
        if (step === 1) {
          const toolChunk = {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_gemini3_search_1",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: '{"query":"over 1.5 goals"}',
                      },
                      extra_content: {
                        google: { thought_signature: expectedSig },
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            model: "gemini-3.5-flash-lite",
            object: "chat.completion.chunk",
          };
          return new Response(
            `data: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]\n\n`,
            {
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            },
          );
        }

        const assistantCall = body.messages?.find(
          (m) => m.role === "assistant" && m.tool_calls?.length,
        )?.tool_calls?.[0];
        receivedStep2Sig =
          assistantCall?.extra_content?.google?.thought_signature;
        if (receivedStep2Sig !== expectedSig) {
          return Response.json(
            {
              error: {
                code: 400,
                message: "Function call is missing a thought_signature",
              },
            },
            { status: 400 },
          );
        }

        const answerChunk = {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Found the top teams from web search.",
              },
              finish_reason: "stop",
            },
          ],
          model: "gemini-3.5-flash-lite",
          object: "chat.completion.chunk",
        };
        return new Response(
          `data: ${JSON.stringify(answerChunk)}\n\ndata: [DONE]\n\n`,
          {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        );
      },
    });

    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.COPILOTKIT_OPENAI_API = "chat";

    const agent = new BuiltInAgentWithSaneHistory(
      {
        model: "openai/gemini-3.5-flash-lite",
        apiKey: "synthetic-gemini-key",
        prompt: "Be helpful.",
        maxSteps: 4,
        tools: [
          {
            name: "web_search",
            description: "Search the web.",
            parameters: z.object({ query: z.string() }),
            execute: async () => ({ results: ["Eredivisie: PSV, Ajax"] }),
          },
        ],
      } as BuiltInAgentConfiguration,
      {
        inline: async (messages) => messages,
        observe: (events) => events,
      },
    );
    agent.addMessage({
      id: "m1",
      role: "user",
      content: "Find the teams.",
    });

    await agent.runAgent();

    expect(step).toBe(2);
    expect(receivedStep2Sig).toBe(expectedSig);
    expect(agent.messages.at(-1)?.content).toBe(
      "Found the top teams from web search.",
    );
  });
});

describe("injectThoughtSignatures", () => {
  test("injects cached signature, falls back to Gemini sentinel on persisted calls, and leaves non-Gemini models untouched", () => {
    const cache = new Map([["call-cached", "sig-real-123"]]);
    const geminiReq = JSON.stringify({
      model: "gemini-3.5-flash-lite",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-cached",
              type: "function",
              function: { name: "a", arguments: "{}" },
            },
            {
              id: "call-persisted",
              type: "function",
              function: { name: "b", arguments: "{}" },
            },
          ],
        },
      ],
    });
    const updated = injectThoughtSignatures(geminiReq, cache);
    expect(updated).not.toBeNull();
    const parsed = JSON.parse(updated ?? "{}") as {
      messages: [
        {
          tool_calls: Array<{
            extra_content?: { google?: { thought_signature?: string } };
          }>;
        },
      ];
    };
    expect(
      parsed.messages[0].tool_calls[0]?.extra_content?.google
        ?.thought_signature,
    ).toBe("sig-real-123");
    expect(
      parsed.messages[0].tool_calls[1]?.extra_content?.google
        ?.thought_signature,
    ).toBe("skip_thought_signature_validator");

    const nonGeminiReq = JSON.stringify({
      model: "local-fast",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-unknown",
              type: "function",
              function: { name: "a", arguments: "{}" },
            },
          ],
        },
      ],
    });
    expect(injectThoughtSignatures(nonGeminiReq, cache)).toBeNull();
  });
});

describe("normalizeChatCompletionsRequest", () => {
  test("defaults reasoning_effort to low for Gemini 3 Flash models when unset, while preserving explicit effort and non-Flash models", () => {
    const flashLiteReq = JSON.stringify({
      model: "gemini-3.5-flash-lite",
      messages: [{ role: "user", content: "Hello" }],
    });
    const updatedFlashLite = normalizeChatCompletionsRequest(flashLiteReq);
    expect(updatedFlashLite).not.toBeNull();
    expect(JSON.parse(updatedFlashLite ?? "{}").reasoning_effort).toBe("low");

    const flashReq = JSON.stringify({
      model: "openai/gemini-3.8-flash",
      messages: [{ role: "user", content: "Hello" }],
    });
    const updatedFlash = normalizeChatCompletionsRequest(flashReq);
    expect(updatedFlash).not.toBeNull();
    expect(JSON.parse(updatedFlash ?? "{}").reasoning_effort).toBe("low");

    const explicitEffortReq = JSON.stringify({
      model: "gemini-3.5-flash-lite",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Deep analysis" }],
    });
    expect(normalizeChatCompletionsRequest(explicitEffortReq)).toBeNull();

    const proReq = JSON.stringify({
      model: "gemini-3.1-pro-preview",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(normalizeChatCompletionsRequest(proReq)).toBeNull();

    const localReq = JSON.stringify({
      model: "local-fast",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(normalizeChatCompletionsRequest(localReq)).toBeNull();
  });
});
