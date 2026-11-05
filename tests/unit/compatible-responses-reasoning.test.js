import { afterEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const NODE = "openai-compatible-responses-test";
const MODEL = "gpt-6-astra";
const credentials = { apiKey: "test-key", providerSpecificData: { baseUrl: "https://relay.example/v1", apiType: "responses" } };
const tool = { name: "lookup", description: "Look up a test value", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };

afterEach(() => vi.clearAllMocks());

describe("compatible Responses reasoning on the outbound HTTP request", () => {
  it.each([
    [FORMATS.CLAUDE, { thinking: { type: "enabled", budget_tokens: 8192 } }, "medium"],
    [FORMATS.CLAUDE, { output_config: { effort: "max" }, thinking: { type: "adaptive" } }, "max"],
    [FORMATS.OPENAI, { reasoning_effort: "max" }, "max"],
    [FORMATS.OPENAI_RESPONSES, { reasoning: { effort: "high" } }, "high"],
  ])("translates %s thinking %j into the Responses wire format", async (source, thinking, effort) => {
    const body = source === FORMATS.OPENAI_RESPONSES
      ? { input: "Reply OK", ...thinking }
      : { messages: [{ role: "user", content: "Reply OK" }], ...thinking };
    const translated = translateRequest(source, FORMATS.OPENAI_RESPONSES, MODEL, body, true, {}, NODE);
    fetchMock.mockImplementationOnce(async (_url, options) => {
      const wire = JSON.parse(options.body);
      return new Response(JSON.stringify(wire.reasoning_effort !== undefined
        ? { error: { message: "Unsupported parameter: reasoning_effort" } }
        : { id: "resp_test", object: "response", output: [] }), {
        status: wire.reasoning_effort !== undefined ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await new DefaultExecutor(NODE).execute({ model: MODEL, body: translated, stream: true, credentials });
    expect(result.response.status).toBe(200);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.example/v1/responses");
    const wire = JSON.parse(options.body);
    expect(wire.reasoning.effort).toBe(effort);
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it("keeps Claude tool calls and results linked while converting max effort", () => {
    const body = {
      thinking: { type: "adaptive" }, output_config: { effort: "max" }, tools: [tool],
      messages: [
        { role: "user", content: "Look up the test value" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_lookup", name: "lookup", input: { key: "test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_lookup", content: "42" }] },
      ],
    };
    const translated = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, MODEL, body, true, {}, NODE);
    const wire = new DefaultExecutor(NODE).transformRequest(MODEL, translated, true, credentials);
    expect(wire.reasoning.effort).toBe("max");
    expect(wire).not.toHaveProperty("reasoning_effort");
    expect(wire.tools).toEqual([expect.objectContaining({ type: "function", name: "lookup" })]);
    expect(wire.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"key":"test"}' }));
    expect(wire.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_lookup", output: "42" }));
  });

  it("preserves an explicit nested effort and reasoning metadata", () => {
    const body = { input: "hi", reasoning_effort: "low", reasoning: { effort: "max", summary: "detailed" } };
    const wire = new DefaultExecutor(NODE).transformRequest(MODEL, body, false, credentials);
    expect(wire.reasoning).toEqual({ effort: "max", summary: "detailed" });
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it.each([true, false])("keeps explicit none and stream=%s", (stream) => {
    const body = { input: "hi", stream, reasoning_effort: "none" };
    const wire = new DefaultExecutor(NODE).transformRequest(MODEL, body, stream, credentials);
    expect(wire.reasoning).toEqual({ effort: "none" });
    expect(wire.stream).toBe(stream);
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it("uses the upstream default for adaptive effort instead of sending auto", () => {
    const body = { input: "hi", reasoning_effort: "auto" };
    const wire = new DefaultExecutor(NODE).transformRequest(MODEL, body, true, credentials);
    expect(wire.reasoning?.effort).toBeUndefined();
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it("resolves legacy node IDs using their configured API type", () => {
    const wire = new DefaultExecutor("openai-compatible-legacy").transformRequest(MODEL, { input: "hi", reasoning_effort: "max" }, true, credentials);
    expect(wire.reasoning).toEqual({ effort: "max" });
    expect(wire).not.toHaveProperty("reasoning_effort");
  });

  it("leaves Chat Completions reasoning unchanged", () => {
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" };
    const wire = new DefaultExecutor("openai-compatible-chat-test").transformRequest(MODEL, body, true, { ...credentials, providerSpecificData: { ...credentials.providerSpecificData, apiType: "chat" } });
    expect(wire.reasoning_effort).toBe("max");
    expect(wire).not.toHaveProperty("reasoning");
  });
});
