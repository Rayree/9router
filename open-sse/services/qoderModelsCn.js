/**
 * Qoder CN (国内版) model catalog fetcher.
 *
 * Calls /api/v2/model/list (COSY-signed) on qoder.cn to get the live catalog
 * for an authenticated Qoder CN account, then caches the per-model
 * `model_config` blocks by key. Chat requests later look up the exact
 * server-published metadata for the model they want — Qoder's chat endpoint
 * silently downgrades to a different model when the wrong model_config is sent.
 *
 * On any error the live cache stays empty and chatExecuteCall surfaces the
 * problem to the user as "model config not yet fetched, retry shortly".
 *
 * PAT (Personal Access Token, pt-...) connections: a PAT cannot sign COSY
 * requests directly, so we exchange it for a short-lived job token (jt-...)
 * via qoder.cn/api/v1/jobToken/exchange (plain JSON POST), then use
 * that job token for signing.
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import {
  QODER_CN_MODEL_LIST_URL,
  QODER_CN_JOB_TOKEN_EXCHANGE_URL,
  QODER_CN_USERINFO_URL,
  QODER_CN_IDE_VERSION,
  QODER_CN_CLIENT_TYPE,
} from "../shared/qoder-cn/constants.js";

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
      },
      body: JSON.stringify({ token: pat }),
      signal,
    },
    proxyOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`qoder-cn PAT exchange failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const body = await response.json();
  if (!body.token || !body.user_id) {
    throw new Error("qoder-cn PAT exchange: missing token or user_id in response");
  }

  const entry = {
    accessToken: body.token,
    userId: body.user_id,
    expiresAt: Date.now() + (body.expires_in ? body.expires_in * 1000 : PAT_DEFAULT_TTL_MS),
  };
  patJobCache.set(pat, entry);
  return entry;
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
 */
async function fetchCatalog(credentials, proxyOptions, signal) {
  const psd = credentials.providerSpecificData || {};
  if (!psd.userId || !credentials.accessToken) return null;

  const emptyBody = Buffer.from("{}", "utf8");
  const encodedBodyStr = qoderEncodeBody(emptyBody);
  const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

  let cosyHeaders;
  try {
    cosyHeaders = buildCosyHeaders(
      encodedBodyBuf,
      QODER_CN_MODEL_LIST_URL,
      {
        userId: psd.userId,
        authToken: credentials.accessToken,
        name: credentials.displayName || "",
        email: credentials.email || "",
        machineId: psd.machineId || "",
      },
    );
  } catch {
    return null;
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...cosyHeaders,
  };

  const timeoutMs = FETCH_TIMEOUT_MS;
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
  const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

  let response;
  try {
    response = await proxyAwareFetch(
      QODER_CN_MODEL_LIST_URL,
      { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
      proxyOptions,
    );
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok) return null;

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { return null; }

  const models = Array.isArray(body?.data) ? body.data : [];
  const rawConfigs = new Map();
  for (const m of models) {
    if (m && typeof m === "object" && m.key) {
      rawConfigs.set(m.key, m);
    }
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
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
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
