import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const credentials = { apiKey: "test-key", providerSpecificData: { baseUrl: "https://relay.example/v1" } };
const args = { model: "gpt-6-astra", body: { input: "hi", stream: true }, stream: true, credentials };

function delayedHeaders(delayMs) {
  return (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response("event: response.completed\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })), delayMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("compatible Responses slow response headers", () => {
  it.each(["openai-compatible-responses-test", "openai-compatible-legacy"])("lets %s finish a 70-second prefill without replaying it", async (provider) => {
    fetchMock.mockImplementation(delayedHeaders(70000));
    const pending = new DefaultExecutor(provider).execute({ ...args, credentials: { ...credentials, providerSpecificData: { ...credentials.providerSpecificData, apiType: "responses" } } });
    await vi.advanceTimersByTimeAsync(70001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await pending).response.status).toBe(200);
  });

  it("keeps the normal 60-second budget for Chat nodes", async () => {
    fetchMock.mockImplementation(delayedHeaders(70000));
    const executor = new DefaultExecutor("openai-compatible-chat-test");
    executor.config = { ...executor.config, retry: { 502: { attempts: 0 } } };
    const pending = executor.execute(args).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60001);
    expect((await pending).message).toBe("fetch connect timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still bounds Responses requests that never return headers", async () => {
    fetchMock.mockImplementation(delayedHeaders(250000));
    const executor = new DefaultExecutor("openai-compatible-responses-test");
    executor.config = { ...executor.config, retry: { 502: { attempts: 0 } } };
    const pending = executor.execute(args).catch((error) => error);
    await vi.advanceTimersByTimeAsync(200001);
    expect((await pending).message).toBe("fetch connect timeout");
  });

  it("honors a provider's explicit response-header timeout", async () => {
    fetchMock.mockImplementation(delayedHeaders(70000));
    const executor = new DefaultExecutor("openai-compatible-responses-test");
    executor.config = { ...executor.config, timeoutMs: 15000, retry: { 502: { attempts: 0 } } };
    const pending = executor.execute(args).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15001);
    expect((await pending).message).toBe("fetch connect timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on caller cancellation without retrying", async () => {
    fetchMock.mockImplementation(delayedHeaders(70000));
    const ctrl = new AbortController();
    const pending = new DefaultExecutor("openai-compatible-responses-test").execute({ ...args, signal: ctrl.signal }).catch((error) => error);
    ctrl.abort(new Error("client disconnected"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await pending).message).toBe("client disconnected");
  });

  it("does not dispatch a request that was already cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new DefaultExecutor("openai-compatible-responses-test").execute({ ...args, signal: ctrl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
