/**
 * QoderCnExecutor — sends OpenAI-format chat requests to Qoder CN's COSY-signed
 * inference endpoint at openapi.qoder.com.cn, then unwraps Qoder's
 * `{statusCodeValue, body}` SSE envelope back into plain OpenAI SSE.
 *
 * Verified against the official Qoder CLI CN (v1.1.25) binary:
 *   - API base: openapi.qoder.com.cn (NOT qoder.cn)
 *   - All API calls go to openapi.qoder.com.cn/api/v1/... or /api/v2/...
 *   - No api2/api3 subdomain distinction like the international version
 *   - Same COSY signing, same request shape, same SSE unwrapping
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS, QODER_CN_QUEUE_RETRY_MAX_MS, QODER_CN_QUEUE_RETRY_MAX_ATTEMPTS } from "../config/runtimeConfig.js";
import {
  QODER_CN_CHAT_URL_ENCODED,
  QODER_CN_CHAT_SIG_PATH,
  QODER_CN_MODEL_MAP,
  QODER_CN_IDE_VERSION,
  QODER_CN_CLIENT_TYPE,
  QODER_CN_DATA_POLICY,
  QODER_CN_LOGIN_VERSION,
  QODER_CN_MACHINE_OS,
  QODER_CN_MACHINE_TYPE,
} from "../shared/qoder-cn/constants.js";
import { getQoderCnModelConfig, resolveQoderCnModels, isQoderCnPat, resolveQoderCnCredentials } from "../services/qoderModelsCn.js";

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten any multipart content arrays.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractText(msg.content);
    if (msg.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = text;
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens, attemptSalt = 0) {
  const h = createHash("sha256");
  h.update("qoder-cn-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  if (attemptSalt > 0) h.update(`\0attempt=${attemptSalt}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder CN expects.
 */
async function buildQoderCnRequestBody({ model, body, credentials, log, proxyOptions, signal, attemptSalt = 0 }) {
  const qoderKey = String(model || "").replace(/^qoder-cn\//, "");

  // Fetch model config from dynamic API instead of relying on static QODER_CN_MODEL_MAP.
  // This allows support for new Qoder models without code changes.
  let modelConfig = await getQoderCnModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderCnModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder-cn: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-cn-session", psd.userId, qoderKey);
  // attemptSalt makes each queue-retry a fresh submission: the upstream
  // dedupes on chat_record_id and answers 403 code 103 "Duplicate request"
  // when a retried payload reuses the same record id.
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens, attemptSalt);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Parse Qoder CN's nested error body. The upstream nests JSON in JSON and the
 * nesting depth is NOT uniform:
 *   10605 (queue): {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{...queue state...}\"}"}
 *   112 (paywall): {"code":"112","message":"{\"pricingUrl\":\"https://qoder.com.cn/pricing...\"}"}
 * Walks nested `message` strings (bounded depth) and returns { code, data }
 * with `code` from the deepest level that has one, or null when unparseable.
 */
export function parseQoderCnErrorBody(inner) {
  if (typeof inner !== "string" || !inner) return null;
  let node;
  try { node = JSON.parse(inner); } catch { return null; }
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  let code = node.code !== undefined ? String(node.code) : "";
  let data = node;
  let depth = 0;
  while (typeof data.message === "string" && data.message && depth < 3) {
    let nested;
    try { nested = JSON.parse(data.message); } catch { break; }
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) break;
    if (nested.code !== undefined) code = String(nested.code);
    data = nested;
    depth++;
  }
  return { code, data };
}

/**
 * Parse a 10605 queue/over-capacity error (retryable). Returns null for
 * anything else. On match: { retryAfterMs, queueCount, waitTimeSeconds, isQueued }.
 */
export function parseQoderCnQueueError(inner) {
  const parsed = parseQoderCnErrorBody(inner);
  if (!parsed || parsed.code !== "10605") return null;
  const s = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  const retryAfterSeconds = Number(s.retryAfterSeconds);
  return {
    retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 5000,
    queueCount: Number.isFinite(Number(s.queueCount)) ? Number(s.queueCount) : null,
    waitTimeSeconds: Number.isFinite(Number(s.waitTime)) ? Number(s.waitTime) : null,
    isQueued: s.isQueued === true,
  };
}

/**
 * Parse a 112 quota/paywall error (NOT retryable — the account is out of
 * credits). Returns null for anything else. On match: { pricingUrl }.
 */
export function parseQoderCnPaymentError(inner) {
  const parsed = parseQoderCnErrorBody(inner);
  if (!parsed || parsed.code !== "112") return null;
  const d = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  return { pricingUrl: typeof d.pricingUrl === "string" ? d.pricingUrl : null };
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Errors become a synthetic OpenAI error
 * chunk + [DONE].
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive). Non-streaming clients drain via
 * response.text() which hangs until the socket closes — so on terminal
 * events we cancel the upstream reader and close our stream immediately.
 */
function wrapQoderCnSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;
  const reader = response.body.getReader();

  // Process one already-extracted SSE line (no trailing newline).
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-cn-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder-cn error ${statusVal}: ${truncate(msg, 500)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const stream = new ReadableStream({
    // Use start()+loop (not pull): a pull that buffers a partial line without
    // enqueueing would never be re-invoked, hanging consumers like .text().
    async start(controller) {
      try {
        while (!doneEmitted) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              processLine(buffer, controller);
              buffer = "";
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              // Terminal frame received — drop upstream keepalive and end.
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
      } catch {
        // fall through to terminal [DONE] + close
      } finally {
        if (!doneEmitted) {
          try {
            controller.enqueue(encoder.encode(SSE_DONE));
            doneEmitted = true;
          } catch { /* already closed */ }
        }
        try { controller.close(); } catch { /* already closed */ }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Unique sentinel thrown inside peekQueueError to stop scanning after the
 * first data frame (can't use a string — errors compare by identity).
 */
const STOP_SCAN = Symbol("qoder-cn-stop-scan");

/**
 * Sleep for `ms`, resolving early (true) if `signal` aborts.
 * Returns true when aborted, false after the full sleep.
 */
function sleepAbortable(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(() => resolve(false), ms));
  }
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(true); return; }
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(false); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(true); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read just enough of the upstream SSE stream to classify the FIRST data
 * frame. Returns:
 *   { firstFrame: null, response }   — no data frame within the sniff budget
 *                                      (TTFT timeout or stream ended); response
 *                                      replays everything read so far.
 *   { firstFrame: { error: false }, response } — first frame was a normal 200
 *                                      chunk; response replays it.
 *   { firstFrame: { error: true, statusVal, queue, paywall, rawBody }, response }
 *                                    — first frame was a non-200 envelope:
 *                                      queue (10605, retryable), paywall (112),
 *                                      or other upstream error. `response`
 *                                      replays the error frame; the caller
 *                                      cancels it (error paths never consume it).
 */
async function peekQueueError(response, qoderKey, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstFrame = null;

  // Bound the sniff: if no data frame arrives within the TTFT budget, treat
  // the response as a normal stream and let the stall detector downstream
  // handle a dead upstream (never hang the request on a header-only response).
  const sniffDeadline = Date.now() + STREAM_FIRST_CHUNK_TIMEOUT_MS;
  const SCAN_LIMIT_BYTES = 32 * 1024;
  let scanned = 0;
  try {
    while (scanned < SCAN_LIMIT_BYTES) {
      if (Date.now() > sniffDeadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      scanned += value.length;
      buffer += decoder.decode(value, { stream: true });
      // Look for a complete `data:` frame.
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trimStart();
        if (!data || data === "[DONE]") continue;
        let envelope;
        try { envelope = JSON.parse(data); } catch { continue; }
        const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
        const inner = typeof envelope.body === "string" ? envelope.body : "";
        if (statusVal !== 200) {
          const queue = parseQoderCnQueueError(inner);
          const paywall = queue ? null : parseQoderCnPaymentError(inner);
          firstFrame = { error: true, statusVal, queue, paywall, rawBody: inner };
        } else {
          firstFrame = { error: false };
        }
        // First data frame seen — decision made either way.
        buffer = line + "\n" + buffer; // put the frame back for replay
        throw STOP_SCAN;
      }
    }
  } catch (e) {
    if (e !== STOP_SCAN) throw e;
  }

  // Rebuild a stream that replays everything we read (the frame(s) we pulled
  // out) followed by the unread remainder. `start()` pumps the upstream only
  // while the downstream pulls — an unconsumed replay never buffers.
  const replay = buffer;
  const replayStream = new ReadableStream({
    async start(controller) {
      if (replay) controller.enqueue(new TextEncoder().encode(replay));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch { /* upstream terminated mid-pump — close cleanly */ }
      controller.close();
    },
    cancel(reason) { try { reader.cancel(reason); } catch { /* noop */ } },
  });

  return {
    firstFrame,
    response: new Response(replayStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

export class QoderCnExecutor extends BaseExecutor {
  constructor() {
    super("qoder-cn", PROVIDERS["qoder-cn"]);
  }

  buildUrl(credentials) {
    // Qoder CN serves inference from gateway.qoder.com.cn (auth/account live
    // on openapi.qoder.com.cn). Chat is COSY-signed with an encoded body.
    return QODER_CN_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder CN needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // PAT (pt-...) → exchange for short-lived job token + resolve userId so
    // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
    // job tokens (jt-...) skip this and are used directly.
    const rawToken = credentials?.apiKey || credentials?.accessToken;
    if (isQoderCnPat(rawToken)) {
      try {
        credentials = await resolveQoderCnCredentials(credentials, proxyOptions, signal);
      } catch (err) {
        log?.error?.("QODER-CN", `PAT exchange failed: ${err.message}`);
        const fakeResp = new Response(
          JSON.stringify({ error: { message: `qoder-cn PAT exchange failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url: this.buildUrl(credentials), headers: {}, transformedBody: body };
      }
    }

    const url = this.buildUrl(credentials);
    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder-cn credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder-cn credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    try {
      ({ qoderKey } = await buildQoderCnRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    // Queue-retry loop: when the upstream is over capacity it answers HTTP 200
    // with an SSE envelope whose first frame is a 403/10605 "service queued"
    // error (retryAfterSeconds, queueCount, waitTime). The official clients
    // re-send until admitted; we mirror that here, bounded by a total time
    // budget and an attempt cap, so chatCore keeps the client connection open
    // and a queued request eventually streams instead of failing fast.
    // Each attempt rebuilds the payload with a fresh chat_record_id — the
    // upstream dedupes on it (403 code 103 "Duplicate request") otherwise.
    const queueRetryStart = Date.now();
    for (let attempt = 1; ; attempt++) {
      let payload;
      try {
        ({ payload } = await buildQoderCnRequestBody({ model, body, credentials, log, proxyOptions, signal, attemptSalt: attempt - 1 }));
      } catch (err) {
        const fakeResp = new Response(
          JSON.stringify({ error: { message: err.message } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url, headers: {}, transformedBody: body };
      }

      const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
      const encodedBodyStr = qoderEncodeBody(plainBody);
      const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

      let cosyHeaders;
      try {
        cosyHeaders = buildCosyHeaders(
          encodedBodyBuf,
          url,
          {
            userId: psd.userId,
            authToken: credentials.accessToken,
            name: credentials.displayName || "",
            email: credentials.email || "",
            machineId: psd.machineId || "",
            // CN service requires the CLI CN fingerprint, not the
            // international COSY values.
            cosyVersion: QODER_CN_IDE_VERSION,
            clientType: QODER_CN_CLIENT_TYPE,
            dataPolicy: QODER_CN_DATA_POLICY,
            loginVersion: QODER_CN_LOGIN_VERSION,
            machineOs: QODER_CN_MACHINE_OS,
            machineType: QODER_CN_MACHINE_TYPE,
          },
        );
      } catch (err) {
        // cosy.js throws synchronously on missing userId/authToken — surface
        // as 401 so chatCore prompts re-auth instead of returning a 500.
        const fakeResp = new Response(
          JSON.stringify({ error: { message: `qoder-cn cosy signing failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url, headers: {}, transformedBody: body };
      }

      const modelSource = (payload.model_config && payload.model_config.source) || "system";
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Model-Key": qoderKey,
        "X-Model-Source": modelSource,
        // gzip triggers signature validation on Qoder's CDN; force identity.
        "Accept-Encoding": "identity",
        ...cosyHeaders,
      };

      // Abort if upstream doesn't return response headers within connect timeout.
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      let response;
      try {
        response = await proxyAwareFetch(
          url,
          { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
          proxyOptions,
        );
      } finally {
        clearTimeout(connectTimer);
      }

      if (!response.ok) {
        // Pass error response through unchanged so chatCore can capture it.
        return { response, url, headers, transformedBody: payload };
      }

      // Sniff the first SSE frame to classify the response BEFORE committing
      // to the stream. peekQueueError returns the first frame's parsed
      // envelope, and hands back a re-wrapped response with the frame
      // re-queued, so nothing is lost in either path.
      const sniffed = await peekQueueError(response, qoderKey, signal);
      if (!sniffed.firstFrame) {
        // No data frame within the sniff budget — treat as a normal stream
        // (slow upstreams fall through to the stall detector downstream).
        const wrapped = wrapQoderCnSSE(sniffed.response, `qoder-cn/${qoderKey}`);
        return { response: wrapped, url, headers, transformedBody: payload };
      }

      if (sniffed.firstFrame.error) {
        // Non-200 envelope frame: queue (retryable) or hard error (paywall /
        // auth / anything else). Hard errors must NOT be retried — surface
        // immediately as a real error response so chatCore records FAILED.
        try { sniffed.response.body.cancel(); } catch { /* noop */ }
        const { statusVal, queue, paywall, rawBody } = sniffed.firstFrame;
        if (queue) {
          const q = { ...queue, modelKey: qoderKey };
          const elapsed = Date.now() - queueRetryStart;
          const budgetLeft = QODER_CN_QUEUE_RETRY_MAX_MS - elapsed;
          const isLastAllowed = attempt >= QODER_CN_QUEUE_RETRY_MAX_ATTEMPTS || budgetLeft <= q.retryAfterMs;
          if (!isLastAllowed) {
            // Wait out the advisory backoff (capped by the remaining budget),
            // then re-send. Cancel the replay stream first — its pump would
            // otherwise keep buffering the upstream body (agent keepalive
            // keeps the socket open) into memory while nobody consumes it.
            const waitMs = Math.min(q.retryAfterMs, budgetLeft);
            log?.info?.("QODER-CN", `queue retry · ${q.modelKey} · attempt ${attempt}/${QODER_CN_QUEUE_RETRY_MAX_ATTEMPTS} · wait ${Math.round(waitMs / 1000)}s${q.queueCount != null ? ` · queue=${q.queueCount}` : ""}${q.waitTimeSeconds != null ? ` · ETA=${q.waitTimeSeconds}s` : ""}`);
            const aborted = await sleepAbortable(waitMs, signal);
            if (aborted) {
              const fakeResp = new Response(
                JSON.stringify({ error: { message: `qoder-cn queue wait aborted after ${attempt} attempt(s)` } }),
                { status: 499, headers: { "Content-Type": "application/json" } },
              );
              return { response: fakeResp, url, headers, transformedBody: payload };
            }
            continue;
          }
          // Budget/attempts exhausted — 503 with the full queue state.
          const detail = [
            q.queueCount != null ? `queue=${q.queueCount}` : null,
            q.waitTimeSeconds != null ? `est wait=${q.waitTimeSeconds}s` : null,
          ].filter(Boolean).join(", ");
          const message = `qoder-cn model ${q.modelKey} is over capacity${detail ? ` (${detail})` : ""} — retried ${attempt}x over ${Math.round(elapsed / 1000)}s, still queued. Try a different model or retry later.`;
          log?.warn?.("QODER-CN", message);
          const fakeResp = new Response(
            JSON.stringify({ error: { message, type: "over_capacity", code: "qoder_cn_queue_exhausted" } }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
          return { response: fakeResp, url, headers, transformedBody: payload };
        }

        // Hard error (not a queue) — never retry. Include the parsed code and
        // a readable body so the user can see WHY (e.g. 112 paywall with the
        // pricing URL) instead of a 200-char blob.
        const parsed = parseQoderCnErrorBody(rawBody);
        const parsedCode = parsed?.code ? ` (code ${parsed.code})` : "";
        let hint = "";
        if (paywall) {
          hint = ` — Qoder CN account is out of credits${paywall.pricingUrl ? `, see ${paywall.pricingUrl}` : ""}. Top up or switch to a different provider/model.`;
        }
        const message = `qoder-cn upstream error ${statusVal}${parsedCode}: ${truncate(rawBody, 400)}${hint}`;
        log?.warn?.("QODER-CN", message);
        const fakeResp = new Response(
          JSON.stringify({ error: { message, code: parsed?.code || null, type: paywall ? "quota_exhausted" : "upstream_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url, headers, transformedBody: payload };
      }

      // First frame was a normal 200 chunk — wrap and stream.
      const wrapped = wrapQoderCnSSE(sniffed.response, `qoder-cn/${qoderKey}`);
      return { response: wrapped, url, headers, transformedBody: payload };
    }
  }

  // Qoder CN device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderCnExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderCnExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderCnSSE,
  buildQoderCnRequestBody,
  parseQoderCnErrorBody,
  parseQoderCnQueueError,
  parseQoderCnPaymentError,
  peekQueueError,
  sleepAbortable,
};
