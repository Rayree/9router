/**
 * Unit tests for Qoder CN error classification + queue-retry internals.
 *
 * Fixtures are the real upstream payloads captured 2026-08-28:
 *   - 10605 queue error: 3-level nested JSON (outer 403 → 10605 → queue state)
 *   - 112 paywall error: 2-level nested JSON (outer 403 → pricingUrl)
 *   - normal 200 chunk envelope
 */

import { describe, it, expect } from "vitest";

import { __test__ } from "../../open-sse/executors/qoder-cn.js";

const { parseQoderCnErrorBody, parseQoderCnQueueError, parseQoderCnPaymentError, peekQueueError } = __test__;

// Captured 2026-08-28: queue had grown to 2406, retryAfterSeconds 30, waitTime 248.
const QUEUE_BODY = JSON.stringify({
  code: "403",
  message: JSON.stringify({
    code: "10605",
    message: JSON.stringify({
      isQueued: true,
      modelKey: "qmodel_38max",
      queueCount: 2406,
      queueType: "slow",
      retryAfterSeconds: 30,
      serviceAvailable: true,
      waitTime: 248,
    }),
  }),
});

// Captured 2026-08-28 (user report): account out of credits.
const PAYWALL_BODY = JSON.stringify({
  code: "112",
  message: JSON.stringify({ pricingUrl: "https://qoder.com.cn/pricing?client=qoder" }),
});

// Also seen in the wild: 403 wrapper around code 112.
const PAYWALL_BODY_403 = JSON.stringify({
  code: "403",
  message: JSON.stringify({
    code: "112",
    message: JSON.stringify({ pricingUrl: "https://qoder.com.cn/pricing?client=qoder" }),
  }),
});

const NORMAL_BODY = JSON.stringify({
  id: "chatcmpl-x",
  choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
});

function sseResponse(lines, init = {}) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
}

describe("parseQoderCnErrorBody — nested JSON walking", () => {
  it("extracts code 10605 from the 3-level queue payload", () => {
    const parsed = parseQoderCnErrorBody(QUEUE_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed.code).toBe("10605");
    expect(parsed.data.modelKey).toBe("qmodel_38max");
    expect(parsed.data.queueCount).toBe(2406);
  });

  it("extracts code 112 from the 2-level paywall payload", () => {
    const parsed = parseQoderCnErrorBody(PAYWALL_BODY);
    expect(parsed).not.toBeNull();
    expect(parsed.code).toBe("112");
    expect(parsed.data.pricingUrl).toContain("qoder.com.cn/pricing");
  });

  it("extracts code 112 from the 3-level (403-wrapped) paywall payload", () => {
    const parsed = parseQoderCnErrorBody(PAYWALL_BODY_403);
    expect(parsed).not.toBeNull();
    expect(parsed.code).toBe("112");
    expect(parsed.data.pricingUrl).toContain("qoder.com.cn/pricing");
  });

  it("returns null for non-JSON / non-object bodies", () => {
    expect(parseQoderCnErrorBody("")).toBeNull();
    expect(parseQoderCnErrorBody("plain text error")).toBeNull();
    expect(parseQoderCnErrorBody("[1,2,3]")).toBeNull();
    expect(parseQoderCnErrorBody(null)).toBeNull();
  });
});

describe("parseQoderCnQueueError — 10605 only", () => {
  it("parses queue state with retry timing", () => {
    const q = parseQoderCnQueueError(QUEUE_BODY);
    expect(q).not.toBeNull();
    expect(q.retryAfterMs).toBe(30_000);
    expect(q.queueCount).toBe(2406);
    expect(q.waitTimeSeconds).toBe(248);
    expect(q.isQueued).toBe(true);
  });

  it("rejects the paywall body", () => {
    expect(parseQoderCnQueueError(PAYWALL_BODY)).toBeNull();
    expect(parseQoderCnQueueError(PAYWALL_BODY_403)).toBeNull();
  });

  it("falls back to 5s retry when retryAfterSeconds is missing/invalid", () => {
    const body = JSON.stringify({ code: "10605", message: JSON.stringify({ isQueued: false }) });
    const q = parseQoderCnQueueError(body);
    expect(q).not.toBeNull();
    expect(q.retryAfterMs).toBe(5000);
    expect(q.queueCount).toBeNull();
    expect(q.waitTimeSeconds).toBeNull();
    expect(q.isQueued).toBe(false);
  });
});

describe("parseQoderCnPaymentError — 112 only", () => {
  it("parses the pricing URL from both nesting shapes", () => {
    const a = parseQoderCnPaymentError(PAYWALL_BODY);
    const b = parseQoderCnPaymentError(PAYWALL_BODY_403);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.pricingUrl).toContain("qoder.com.cn/pricing");
    expect(b.pricingUrl).toContain("qoder.com.cn/pricing");
  });

  it("rejects the queue body and normal chunks", () => {
    expect(parseQoderCnPaymentError(QUEUE_BODY)).toBeNull();
    expect(parseQoderCnPaymentError(NORMAL_BODY)).toBeNull();
  });
});

describe("peekQueueError — first-frame classification + replay", () => {
  it("classifies a queue error frame and keeps the bytes for replay", async () => {
    const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: QUEUE_BODY })}\n\n`;
    const res = sseResponse([frame]);
    const sniffed = await peekQueueError(res, "qmodel_38max");
    expect(sniffed.firstFrame.error).toBe(true);
    expect(sniffed.firstFrame.queue).not.toBeNull();
    expect(sniffed.firstFrame.queue.retryAfterMs).toBe(30_000);
    // Replay must contain the original error frame.
    const replayed = await sniffed.response.text();
    expect(replayed).toContain("10605");
  });

  it("classifies a paywall frame as a non-retryable error", async () => {
    const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: PAYWALL_BODY_403 })}\n\n`;
    const res = sseResponse([frame]);
    const sniffed = await peekQueueError(res, "qmodel_38max");
    expect(sniffed.firstFrame.error).toBe(true);
    expect(sniffed.firstFrame.queue).toBeNull();
    expect(sniffed.firstFrame.paywall).not.toBeNull();
    expect(sniffed.firstFrame.paywall.pricingUrl).toContain("qoder.com.cn/pricing");
  });

  it("passes a normal 200 chunk through untouched (content preserved)", async () => {
    const frames = [
      `data: ${JSON.stringify({ statusCodeValue: 200, body: NORMAL_BODY })}\n\n`,
      `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ id: "chatcmpl-x", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] }) })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const res = sseResponse(frames);
    const sniffed = await peekQueueError(res, "qmodel_38max");
    expect(sniffed.firstFrame).toEqual({ error: false });
    // Replay must reproduce the full original byte stream.
    const replayed = await sniffed.response.text();
    expect(replayed).toContain("hello");
    expect(replayed).toContain(" world");
    expect(replayed).toContain("[DONE]");
  });

  it("returns firstFrame null when the stream ends with no data frames", async () => {
    const res = sseResponse([": keepalive\n\n", "\n"]);
    const sniffed = await peekQueueError(res, "qmodel_38max");
    expect(sniffed.firstFrame).toBeNull();
  });

  it("handles a frame split across two reads (partial buffering)", async () => {
    const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: QUEUE_BODY })}\n\n`;
    const bytes = new TextEncoder().encode(frame);
    const mid = Math.floor(bytes.length / 2);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const res = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const sniffed = await peekQueueError(res, "qmodel_38max");
    expect(sniffed.firstFrame.error).toBe(true);
    expect(sniffed.firstFrame.queue).not.toBeNull();
  });
});
