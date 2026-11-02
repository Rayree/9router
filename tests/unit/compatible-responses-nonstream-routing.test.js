// Non-stream clients behind an openai-compatible Responses node, driven through the REAL
// handleChatCore. Only the executor's HTTP response is mocked, and it answers the way a
// real Responses upstream does (free.hiyo.top, 2026-11-01): SSE when the wire body says
// stream:true, plain JSON when it says stream:false.
//
// Regression: the fork once forced stream=true for every compatible Responses node. A
// Responses client is not translated (same format), so the upstream still received
// stream:false and answered JSON, which was then piped through the streaming handler and
// reached the client as text/event-stream: "<json>data: [DONE]".
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const NODE_ID = "openai-compatible-responses-00000000-0000-4000-8000-000000000000";
const TEXT = "pong";
const USAGE = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };
const MESSAGE_ITEM = {
  type: "message", id: "msg_1", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: TEXT, annotations: [] }],
};
const RESPONSE = {
  id: "resp_1", object: "response", created_at: 1793537199, status: "completed",
  model: "gpt-5.6-luna", output: [MESSAGE_ITEM], usage: USAGE,
};

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const RESPONSE_SSE = sse([
  { type: "response.created", response: { ...RESPONSE, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { ...MESSAGE_ITEM, content: [] } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: TEXT },
  { type: "response.output_item.done", output_index: 0, item: MESSAGE_ITEM },
  { type: "response.completed", response: RESPONSE },
]);

// Answer like a real Responses upstream: the wire body's stream flag decides the shape.
function upstreamReply({ body }) {
  const streaming = body?.stream === true;
  return {
    response: new Response(streaming ? RESPONSE_SSE : JSON.stringify(RESPONSE), {
      status: 200,
      headers: { "content-type": streaming ? "text/event-stream" : "application/json; charset=utf-8" },
    }),
    url: "https://relay.example/v1/responses",
    headers: {},
    transformedBody: body,
  };
}

const BODIES = {
  "openai-responses": { model: "gpt-5.6-luna", stream: false, input: "Reply with exactly: pong" },
  openai: { model: "gpt-5.6-luna", stream: false, messages: [{ role: "user", content: "Reply with exactly: pong" }] },
  claude: { model: "gpt-5.6-luna", stream: false, max_tokens: 64, messages: [{ role: "user", content: "Reply with exactly: pong" }] },
};

async function callNode(sourceFormat, { body = BODIES[sourceFormat], headers } = {}) {
  executeMock.mockImplementationOnce(async (args) => upstreamReply(args));
  const result = await handleChatCore({
    body: structuredClone(body),
    clientRawRequest: headers ? { endpoint: "/v1/responses", body, headers } : undefined,
    modelInfo: { provider: NODE_ID, model: "gpt-5.6-luna" },
    credentials: { apiKey: "test-key", providerSpecificData: { apiType: "responses", baseUrl: "https://relay.example/v1" } },
    connectionId: "compat-responses-test",
    sourceFormatOverride: sourceFormat,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });
  const wireBody = executeMock.mock.calls.at(-1)[0].body;
  const contentType = result.response?.headers.get("content-type") || "";
  const text = result.response ? await result.response.text() : "";
  return { result, wireBody, contentType, text };
}

describe("openai-compatible Responses node + non-stream client (via real handleChatCore)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns plain JSON to a non-stream Responses client (upstream answered JSON)", async () => {
    const { result, wireBody, contentType, text } = await callNode("openai-responses");
    expect(result.success).toBe(true);
    expect(wireBody.stream).toBe(false);
    expect(contentType).toContain("application/json");
    expect(text).not.toContain("data: [DONE]");
    const json = JSON.parse(text);
    expect(json.object).toBe("response");
    expect(json.output.find((o) => o.type === "message").content[0].text).toBe(TEXT);
  });

  it("returns plain JSON to an SDK-style Responses call (no stream field, Accept: application/json)", async () => {
    const { stream: _omit, ...body } = BODIES["openai-responses"];
    const { result, wireBody, contentType, text } = await callNode("openai-responses", { body, headers: { accept: "application/json" } });
    expect(result.success).toBe(true);
    expect(wireBody.stream).not.toBe(true);
    expect(contentType).toContain("application/json");
    expect(JSON.parse(text).output.find((o) => o.type === "message").content[0].text).toBe(TEXT);
  });

  it("aggregates the forced upstream SSE into chat.completion JSON for a non-stream Chat client", async () => {
    const { result, wireBody, contentType, text } = await callNode("openai");
    expect(result.success).toBe(true);
    expect(wireBody.stream).toBe(true); // openaiToOpenAIResponsesRequest pins stream:true
    expect(contentType).toContain("application/json");
    const json = JSON.parse(text);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe(TEXT);
  });

  it("aggregates the forced upstream SSE into a Claude message for a non-stream Claude client", async () => {
    const { result, wireBody, contentType, text } = await callNode("claude");
    expect(result.success).toBe(true);
    expect(wireBody.stream).toBe(true);
    expect(contentType).toContain("application/json");
    const json = JSON.parse(text);
    expect(json.type).toBe("message");
    expect(json.content.find((b) => b.type === "text").text).toBe(TEXT);
  });
});
