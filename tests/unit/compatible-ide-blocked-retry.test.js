import { describe, expect, it, vi, afterEach } from "vitest";

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

// Multi-channel new-api relays gate IDE/toolchain clients per channel
// (403 ide_request_blocked). The executor must transparently re-roll the
// channel instead of surfacing the 403 (which locks the connection).
describe("DefaultExecutor ide_request_blocked channel-rotation retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a gated-channel 403 and returns the next non-403 response", async () => {
    const spy = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockImplementationOnce(async () => ({
        response: new Response('{"error":{"message":"检测到来自 IDE 环境或工具链的请求","code":"ide_request_blocked"}}', { status: 403 }),
      }))
      .mockImplementationOnce(async () => ({
        response: new Response('{"choices":[{"message":{"role":"assistant","content":"OK"}}]}', { status: 200 }),
      }));
    const executor = new DefaultExecutor("openai-compatible-chat-test");
    const result = await executor.execute({ model: "m", body: {}, stream: true, credentials: {} });
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.choices[0].message.content).toBe("OK");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns a non-marker 403 untouched with a re-readable body", async () => {
    const spy = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockImplementationOnce(async () => ({
        response: new Response('{"error":{"message":"forbidden"}}', { status: 403 }),
      }));
    const executor = new DefaultExecutor("openai-compatible-chat-test");
    const result = await executor.execute({ model: "m", body: {}, stream: true, credentials: {} });
    expect(result.response.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
    // Downstream handlers re-read the error body — it must not be consumed.
    const body = await result.response.text();
    expect(body).toContain("forbidden");
  });

  it("gives up after the retry budget and preserves the error body", async () => {
    const spy = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockImplementation(async () => ({
        response: new Response('{"error":{"code":"ide_request_blocked"}}', { status: 403 }),
      }));
    const executor = new DefaultExecutor("openai-compatible-chat-test");
    const result = await executor.execute({ model: "m", body: {}, stream: true, credentials: {} });
    expect(result.response.status).toBe(403);
    const body = await result.response.text();
    expect(body).toContain("ide_request_blocked");
    expect(spy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not touch non-403 responses", async () => {
    const spy = vi.spyOn(BaseExecutor.prototype, "execute")
      .mockImplementationOnce(async () => ({
        response: new Response('{"choices":[{"message":{"role":"assistant","content":"hi"}}]}', { status: 200 }),
      }));
    const executor = new DefaultExecutor("openai-compatible-chat-test");
    const result = await executor.execute({ model: "m", body: {}, stream: true, credentials: {} });
    expect(result.response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
