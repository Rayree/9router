/**
 * Unit tests for Qoder CN (国内版) — constants + PAT exchange shape.
 *
 * Verified against the official Qoder CLI CN (v1.1.25) binary:
 *   - Auth/account domain: openapi.qoder.com.cn (not qoder.cn)
 *   - Inference domain: gateway.qoder.com.cn
 *   - PAT exchange sends { personal_token }, not { token }
 *   - exchange response `expires_in` is milliseconds (86400000 = 24h)
 *   - model list is a GET on the gateway domain (grouped by scene)
 *   - COSY fingerprint is the CLI CN version (1.1.25)
 *   - alias `qdcn` is registered with the full model catalog
 */

import { describe, it, expect } from "vitest";

import {
  QODER_CN_BASE,
  QODER_CN_OPENAPI_BASE,
  QODER_CN_GATEWAY_BASE,
  QODER_CN_JOB_TOKEN_EXCHANGE_URL,
  QODER_CN_USERINFO_URL,
  QODER_CN_MODEL_LIST_URL,
  QODER_CN_CHAT_URL,
  QODER_CN_CHAT_URL_ENCODED,
  QODER_CN_QUOTA_USAGE_URL,
  QODER_CN_SCENE,
  QODER_CN_MODEL_MAP,
  QODER_CN_IDE_VERSION,
  QODER_CN_CLIENT_TYPE,
  QODER_CN_MACHINE_OS,
} from "../../open-sse/shared/qoder-cn/constants.js";
import { isQoderCnPat } from "../../open-sse/services/qoderModelsCn.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";

describe("Qoder CN constants — domain split", () => {
  it("auth/account domain is openapi.qoder.com.cn, not qoder.cn", () => {
    expect(QODER_CN_OPENAPI_BASE).toBe("https://openapi.qoder.com.cn");
    expect(QODER_CN_OPENAPI_BASE).not.toContain("https://qoder.cn");
    expect(QODER_CN_BASE).toBe(QODER_CN_OPENAPI_BASE);
  });

  it("inference domain is gateway.qoder.com.cn", () => {
    expect(QODER_CN_GATEWAY_BASE).toBe("https://gateway.qoder.com.cn");
  });

  it("PAT exchange hits openapi.qoder.com.cn/api/v1/jobToken/exchange", () => {
    expect(QODER_CN_JOB_TOKEN_EXCHANGE_URL).toBe(
      "https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
    );
  });

  it("userinfo / quota are on the openapi (auth) host", () => {
    expect(QODER_CN_USERINFO_URL).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
    expect(QODER_CN_QUOTA_USAGE_URL).toBe("https://openapi.qoder.com.cn/api/v2/quota/usage");
  });

  it("model list and chat are on the gateway (inference) host", () => {
    // /algo prefix is mandatory — without it the ALB edge 503s before the app
    // layer (calibrated live 2026-08-28, see FORK.md).
    expect(QODER_CN_MODEL_LIST_URL).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list");
    expect(QODER_CN_CHAT_URL).toContain(
      "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    );
    expect(QODER_CN_CHAT_URL_ENCODED).toBe(`${QODER_CN_CHAT_URL}&Encode=1`);
  });

  it("model catalog scene is assistant (DEFAULT_SCENE from the CLI binary)", () => {
    expect(QODER_CN_SCENE).toBe("assistant");
  });
});

describe("Qoder CN COSY header constants", () => {
  it("uses the CLI CN version + aarch64_darwin machine OS (from the binary)", () => {
    expect(QODER_CN_IDE_VERSION).toBe("1.1.25");
    expect(QODER_CN_CLIENT_TYPE).toBe("5");
    expect(QODER_CN_MACHINE_OS).toBe("aarch64_darwin");
  });
});

describe("Qoder CN model map", () => {
  // The CN catalog shares no tier keys with the international site — the real
  // 13-key list was calibrated from a live PAT catalog pull (2026-08-28, FORK.md).
  const REAL_CN_KEYS = [
    "auto", "qmodel_38max", "qfmodel", "qmodel_latest", "qmodel", "q37fmodel",
    "dmodel", "dfmodel", "gmodel", "gfmodel", "gm51model", "kmodel", "mmodel",
  ];

  it("covers the calibrated CN model keys", () => {
    for (const key of REAL_CN_KEYS) {
      expect(QODER_CN_MODEL_MAP[key]).toBe(key);
    }
  });

  it("registry exposes the full model catalog under alias qdcn", () => {
    const ids = PROVIDER_MODELS.qdcn?.map((m) => m.id) || [];
    for (const key of REAL_CN_KEYS) {
      expect(ids).toContain(key);
    }
    expect(ids.length).toBe(REAL_CN_KEYS.length);
  });
});

describe("isQoderCnPat", () => {
  it("recognizes pt- tokens", () => {
    expect(isQoderCnPat("pt-abc123")).toBe(true);
  });

  it("rejects job tokens and non-PAT strings", () => {
    expect(isQoderCnPat("jt-abc123")).toBe(false);
    expect(isQoderCnPat("")).toBe(false);
    expect(isQoderCnPat(null)).toBe(false);
    expect(isQoderCnPat(undefined)).toBe(false);
  });
});