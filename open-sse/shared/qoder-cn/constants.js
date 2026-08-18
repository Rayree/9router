/**
 * Qoder CN (国内版) API constants.
 *
 * The CN version uses a single domain (qoder.cn) with path-based API routing
 * instead of the international version's subdomain-based routing.
 *
 * Endpoint set:
 *   qoder.cn/api/v1/...   - device flow + userinfo + quota usage
 *   qoder.cn/api/v2/...   - inference (chat) + model list, requires COSY signing
 *   qoder.cn/device       - browser landing page for device authorization
 */

export const QODER_CN_BASE = "https://qoder.cn";

// API path prefix (CN uses path-based routing, not subdomains)
export const QODER_CN_API_PREFIX = "/api";

// Device flow endpoints
export const QODER_CN_DEVICE_TOKEN_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v1/deviceToken/poll`;
export const QODER_CN_USERINFO_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v1/userinfo`;
export const QODER_CN_QUOTA_USAGE_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v2/quota/usage`;
export const QODER_CN_REFRESH_TOKEN_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v3/user/refresh_token`;

// PAT (Personal Access Token, pt-...) → short-lived job token (jt-...) exchange.
// PATs cannot sign COSY requests directly — they must be exchanged first.
// This endpoint is NOT COSY-signed (plain JSON POST).
export const QODER_CN_JOB_TOKEN_EXCHANGE_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v1/jobToken/exchange`;

// Inference endpoints (under /api/v2 on qoder.cn, all COSY-signed)
export const QODER_CN_CHAT_SIG_PATH = "/v2/service/pro/sse/agent_chat_generation";
export const QODER_CN_CHAT_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}${QODER_CN_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CN_CHAT_URL_ENCODED = `${QODER_CN_CHAT_URL}&Encode=1`;
export const QODER_CN_MODEL_LIST_URL = `${QODER_CN_BASE}${QODER_CN_API_PREFIX}/v2/model/list`;

// Login page
export const QODER_CN_LOGIN_URL = `${QODER_CN_BASE}/device/selectAccounts`;

// COSY header constants. These are not arbitrary — the upstream signature
// validation matches them against the values used at signing time.
// Same as international version since it's the same underlying service.
export const QODER_CN_IDE_VERSION = "1.0.0";
export const QODER_CN_CLIENT_TYPE = "5";
export const QODER_CN_DATA_POLICY = "disagree";
export const QODER_CN_LOGIN_VERSION = "v2";
export const QODER_CN_MACHINE_OS = "x86_64_windows";
export const QODER_CN_MACHINE_TYPE = "5";

// Canonical model identifiers. Same as international version.
export const QODER_CN_MODEL_MAP = {
  // Tier models
  auto: "auto",
  ultimate: "ultimate",
  performance: "performance",
  efficient: "efficient",
  lite: "lite",
  // Frontier models
  qmodel: "qmodel",
  qmodel_latest: "qmodel_latest",
  dmodel: "dmodel",
  dfmodel: "dfmodel",
  gm51model: "gm51model",
  kmodel: "kmodel",
  mmodel: "mmodel",
};

// RSA public key for COSY encryption (same as international version).
// Extracted from Qoder IDE v0.9.
export const QODER_CN_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
