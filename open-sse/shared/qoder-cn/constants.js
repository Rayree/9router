/**
 * Qoder CN (国内版) API constants.
 *
 * Verified against the official Qoder CLI CN (v1.1.25) binary:
 *   https://static.qoder.com.cn/qoder-cli-cn/releases/1.1.25/
 *
 * CN splits traffic across TWO domains (unlike the international single-host
 * routing with subdomains):
 *
 *   openapi.qoder.com.cn  — auth + account: PAT exchange, userinfo, quota
 *   gateway.qoder.com.cn  — inference: model list + chat (COSY-signed)
 *
 * Endpoint set (extracted from the binary's brand constants + request code):
 *   openapi.qoder.com.cn/api/v1/...   PAT exchange, userinfo
 *   openapi.qoder.com.cn/api/v2/...   quota usage
 *   gateway.qoder.com.cn/algo/api/v2/...   model list, chat inference, byok
 *
 * CN model list is a GET (not POST) against `?Encode=1`; the response is
 * grouped by scene (DEFAULT_SCENE = "assistant"), not `body.chat` like the
 * international version.
 */

// Auth / account domain.
export const QODER_CN_OPENAPI_BASE = "https://openapi.qoder.com.cn";

// Inference domain.
export const QODER_CN_GATEWAY_BASE = "https://gateway.qoder.com.cn";

// Back-compat alias — most auth/account endpoints live here.
export const QODER_CN_BASE = QODER_CN_OPENAPI_BASE;

// PAT (Personal Access Token, pt-...) → short-lived job token (jt-...) exchange.
// Request body must be `{ personal_token: pt-... }` (NOT `{ token: ... }`).
// Response: { token: "jt-...", refresh_token, expires_in (ms), ... }.
export const QODER_CN_JOB_TOKEN_EXCHANGE_URL = `${QODER_CN_OPENAPI_BASE}/api/v1/jobToken/exchange`;

// User info (GET, Bearer jt-...).
export const QODER_CN_USERINFO_URL = `${QODER_CN_OPENAPI_BASE}/api/v1/userinfo`;

// Quota usage (GET, Bearer jt-...).
export const QODER_CN_QUOTA_USAGE_URL = `${QODER_CN_OPENAPI_BASE}/api/v2/quota/usage`;

// Model list — GET (COSY-signed) on the inference domain. The binary appends
// `?Encode=1` and decrypts the response via the qoder_auth_wasm module; the
// response is grouped by scene key (see QODER_CN_SCENE).
export const QODER_CN_MODEL_LIST_URL = `${QODER_CN_GATEWAY_BASE}/algo/api/v2/model/list`;

// Inference endpoint (POST, COSY-signed, SSE stream).
export const QODER_CN_CHAT_SIG_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CN_CHAT_URL = `${QODER_CN_GATEWAY_BASE}${QODER_CN_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CN_CHAT_URL_ENCODED = `${QODER_CN_CHAT_URL}&Encode=1`;

// Model catalog scene key (DEFAULT_SCENE in the binary).
export const QODER_CN_SCENE = "assistant";

// Web UI (for account management / PAT creation).
export const QODER_CN_WEB_BASE = "https://qoder.cn";
export const QODER_CN_PAT_PAGE_URL = `${QODER_CN_WEB_BASE}/account/integrations`;

// COSY header constants — from the CLI binary (v1.1.25):
//   DEFAULT_CLIENT_TYPE = "5"
//   COSY_VERSION = "1.1.25"
//   COSY_MACHINE_OS = "aarch64_darwin" (the CLI sets this from the runtime
//   platform, not a fixed "x86_64_windows").
export const QODER_CN_IDE_VERSION = "1.1.25";
export const QODER_CN_CLIENT_TYPE = "5";
export const QODER_CN_DATA_POLICY = "disagree";
export const QODER_CN_LOGIN_VERSION = "v2";
export const QODER_CN_MACHINE_OS = "aarch64_darwin";
export const QODER_CN_MACHINE_TYPE = "5";

// Canonical model identifiers. Verified against live /algo/api/v2/model/list on 2026-08-28.
export const QODER_CN_MODEL_MAP = {
  auto: "auto",
  qmodel_38max: "qmodel_38max",
  qfmodel: "qfmodel",
  qmodel_latest: "qmodel_latest",
  qmodel: "qmodel",
  q37fmodel: "q37fmodel",
  dmodel: "dmodel",
  dfmodel: "dfmodel",
  gmodel: "gmodel",
  gfmodel: "gfmodel",
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