/**
 * Qoder CN (国内版) model catalog fetcher.
 *
 * Verified against the official Qoder CLI CN (v1.1.25) binary:
 *   - Auth/account domain: openapi.qoder.com.cn (NOT qoder.cn)
 *   - Inference domain: gateway.qoder.com.cn
 *   - PAT exchange: POST /api/v1/jobToken/exchange with { personal_token }
 *   - Response: { token: "jt-...", refresh_token, expires_in (ms) }
 *   - Model list: GET /api/v2/model/list?Encode=1 (COSY-signed empty body),
 *     response grouped by scene key (assistant)
 *
 * PAT (Personal Access Token, pt-...) connections: a PAT cannot sign COSY
 * requests directly, so we exchange it for a short-lived job token (jt-...)
 * via openapi.qoder.com.cn/api/v1/jobToken/exchange (plain JSON POST), then use
 * that job token for signing.
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import {
  QODER_CN_MODEL_LIST_URL,
  QODER_CN_JOB_TOKEN_EXCHANGE_URL,
  QODER_CN_USERINFO_URL,
  QODER_CN_SCENE,
  QODER_CN_IDE_VERSION,
  QODER_CN_CLIENT_TYPE,
  QODER_CN_DATA_POLICY,
  QODER_CN_LOGIN_VERSION,
  QODER_CN_MACHINE_OS,
  QODER_CN_MACHINE_TYPE,
} from "../shared/qoder-cn/constants.js";

// CN-specific COSY header overrides — the CN service requires the CLI CN
// fingerprint (version 1.1.25, aarch64_darwin), not the international values.
const QODER_CN_COSY_OVERRIDES = {
  cosyVersion: QODER_CN_IDE_VERSION,
  clientType: QODER_CN_CLIENT_TYPE,
  dataPolicy: QODER_CN_DATA_POLICY,
  loginVersion: QODER_CN_LOGIN_VERSION,
  machineOs: QODER_CN_MACHINE_OS,
  machineType: QODER_CN_MACHINE_TYPE,
};

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the Kiro catalog

const PAT_PREFIX = "pt-";

// PAT → job-token cache: a job token is short-lived (24h), so we keep it per
// PAT and re-exchange once it is within 5 minutes of expiry.
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PAT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function isQoderCnPat(token) {
  return typeof token === "string" && token.startsWith(PAT_PREFIX);
}

/** @type {Map<string, { accessToken: string, userId: string, expiresAt: number }>} */
const patJobCache = new Map();

/** @type {Map<string, { expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean }>} */
const catalogCache = new Map();

/**
 * In-flight fetch promises keyed by cacheKey. Concurrent first-time
 * callers (parallel chat windows) all observe the same Promise so we
 * fan-out exactly one upstream request per credential per miss.
 * @type {Map<string, Promise<{ expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean } | null>>}
 */
const inflight = new Map();

function cacheKeyFor(credentials) {
  const raw = credentials?.apiKey || credentials?.accessToken || "";
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

function isExpired(entry, bufferMs = 0) {
  return !entry || Date.now() + bufferMs >= entry.expiresAt;
}

function peekCatalog(credentials) {
  const key = cacheKeyFor(credentials);
  const entry = catalogCache.get(key);
  return isExpired(entry) ? null : entry;
}

/**
 * Exchange a PAT for a short-lived job token. The result is cached per-PAT
 * and refreshed when within 5 minutes of expiry.
 *
 * CN version uses `personal_token` (not `token`) as the request body field,
 * and the response contains `expires_in` in milliseconds (not seconds).
 */
async function exchangePatForJobToken(pat, proxyOptions, signal) {
  const cached = patJobCache.get(pat);
  if (cached && !isExpired(cached, PAT_REFRESH_BUFFER_MS)) {
    return cached;
  }

  const response = await proxyAwareFetch(
    QODER_CN_JOB_TOKEN_EXCHANGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": QODER_CN_IDE_VERSION,
        "Cosy-ClientType": QODER_CN_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
      signal,
    },
    proxyOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`qoder-cn PAT exchange failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const body = await response.json();
  // CN response: { token: "jt-...", refresh_token, expires_in (ms), ... }
  if (!body.token) {
    throw new Error("qoder-cn PAT exchange: missing job token in response");
  }

  // expires_in is in milliseconds (86400000 = 24h), not seconds.
  let expiresAt = Date.now() + PAT_DEFAULT_TTL_MS;
  if (typeof body.expires_in === "number" && body.expires_in > 0) {
    expiresAt = Date.now() + body.expires_in;
  }

  // Fetch userId via userinfo (needed for COSY signing).
  const userId = await fetchUserIdForJobToken(body.token, proxyOptions, signal);

  const entry = {
    accessToken: body.token,
    userId,
    expiresAt,
  };
  patJobCache.set(pat, entry);
  return entry;
}

/**
 * Resolve the Qoder CN userId for a job token (needed for COSY signing).
 * Returns "" on any failure — callers fall back to the stored userId.
 */
async function fetchUserIdForJobToken(jobToken, proxyOptions, signal) {
  try {
    const res = await proxyAwareFetch(
      QODER_CN_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + jobToken,
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
        signal,
      },
      proxyOptions,
    );
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    return data.id || data.userId || data.user_id || "";
  } catch {
    return "";
  }
}

/**
 * Resolve credentials: if the caller passed a PAT, exchange it for a job
 * token and synthesize the credential shape the rest of the pipeline expects.
 */
export async function resolveQoderCnCredentials(credentials, proxyOptions, signal) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (!isQoderCnPat(raw)) return credentials;

  const job = await exchangePatForJobToken(raw, proxyOptions, signal);
  return {
    ...credentials,
    apiKey: job.accessToken,
    accessToken: job.accessToken,
    providerSpecificData: {
      ...(credentials.providerSpecificData || {}),
      userId: job.userId,
    },
  };
}

/**
 * Fetch the live model catalog from Qoder CN. Returns null on any error so
 * callers can surface "not yet known" and retry.
 *
 * Verified from the official CLI CN binary (v1.1.25): this is a GET (not
 * POST) against `?Encode=1` on the gateway domain, COSY-signed with an
 * empty body. The response is grouped by scene (DEFAULT_SCENE = "assistant").
 */
async function fetchCatalog(credentials, proxyOptions, signal) {
  const psd = credentials.providerSpecificData || {};
  if (!psd.userId || !credentials.accessToken) return null;

  let cosyHeaders;
  try {
    cosyHeaders = buildCosyHeaders(
      Buffer.alloc(0),
      QODER_CN_MODEL_LIST_URL,
      {
        userId: psd.userId,
        authToken: credentials.accessToken,
        name: credentials.displayName || "",
        email: credentials.email || "",
        machineId: psd.machineId || "",
        ...QODER_CN_COSY_OVERRIDES,
      },
    );
  } catch {
    return null;
  }

  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": "qodercli/1.0.0",
    ...cosyHeaders,
  };

  const timeoutMs = FETCH_TIMEOUT_MS;
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
  const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

  let response;
  try {
    response = await proxyAwareFetch(
      `${QODER_CN_MODEL_LIST_URL}?Encode=1`,
      { method: "GET", headers, signal: mergedSignal },
      proxyOptions,
    );
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok) return null;

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { return null; }

  // Response is grouped by scene: body[scene] is the model array.
  const sceneModels = (body && typeof body === "object" && !Array.isArray(body))
    ? (body[QODER_CN_SCENE] || body.assistant || body.default || [])
    : Array.isArray(body)
      ? body
      : [];

  const models = [];
  const rawConfigs = new Map();
  for (const m of sceneModels) {
    if (!m || typeof m !== "object") continue;
    const key = m.key;
    if (!key) continue;
    // Always cache the config — chat needs model_config even for UI-hidden
    // models (enable:false). Upstream still accepts chat for these keys.
    rawConfigs.set(key, m);
    if (m.enable === false) continue;
    models.push({
      id: key,
      name: m.display_name || key,
      contextLength: Number(m.max_input_tokens) || 131_072,
      isVL: !!m.is_vl,
      isReasoning: !!m.is_reasoning,
      maxOutputTokens: Number(m.max_output_tokens) || 0,
      description: m.description || "",
    });
  }

  return {
    expiresAt: Date.now() + CACHE_TTL_MS,
    models,
    rawConfigs,
    fetched: true,
  };
}

/**
 * Get the model config for a specific model key, or null if not cached.
 * Use resolveQoderCnModels() to trigger a fetch if needed.
 */
export function getQoderCnModelConfig(credentials, modelKey, { log, proxyOptions, signal } = {}) {
  const cached = peekCatalog(credentials);
  return cached?.rawConfigs.get(modelKey) || null;
}

/**
 * Resolve the model catalog, fetching if necessary. Returns the catalog
 * entry or null on failure.
 */
export async function resolveQoderCnModels(credentials, { forceRefresh = false, log, proxyOptions, signal } = {}) {
  const key = cacheKeyFor(credentials);

  if (!forceRefresh) {
    const cached = peekCatalog(credentials);
    if (cached) return cached;
  }

  // Check if a fetch is already in-flight for this credential
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      // Ensure we have a job token if the caller passed a PAT
      const resolved = await resolveQoderCnCredentials(credentials, proxyOptions, signal);
      const catalog = await fetchCatalog(resolved, proxyOptions, signal);
      if (catalog) {
        catalogCache.set(key, catalog);
      }
      return catalog;
    } catch (err) {
      log?.error?.("QODER-CN", `catalog fetch failed: ${err.message}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Fetch user info for a PAT (used during OAuth or to validate a PAT).
 */
export async function fetchQoderCnUserInfo(accessToken, proxyOptions, signal) {
  try {
    const response = await proxyAwareFetch(
      QODER_CN_USERINFO_URL,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/json",
          "User-Agent": "qodercli/1.0.0",
        },
        signal,
      },
      proxyOptions,
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Clear caches (for testing or when credentials change).
 */
export function clearQoderCnCaches() {
  patJobCache.clear();
  catalogCache.clear();
  inflight.clear();
}