/**
 * Qoder CN (国内版) registry entry.
 *
 * Verified against the official Qoder CLI CN (v1.1.25) binary:
 *   - Auth/account domain: openapi.qoder.com.cn (NOT qoder.cn)
 *   - Inference domain: gateway.qoder.com.cn
 *   - Web UI (PAT creation): qoder.cn/account/integrations
 *   - NO device-code OAuth flow (CN auth = PAT only)
 *   - Auth is PAT-only: user creates a Personal Access Token (pt-...) at
 *     https://qoder.cn/account/integrations and pastes it as an API key
 */

export default {
  id: "qoder-cn",
  priority: 30,
  alias: "qdcn",
  uiAlias: "qdcn",
  display: {
    name: "Qoder CN",
    icon: "water_drop",
    color: "#8B5CF6",
    website: "https://qoder.cn",
    notice: {
      signupUrl: "https://qoder.cn",
      apiKeyUrl: "https://qoder.cn/account/integrations",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  authHint: "Personal Access Token (pt-...) 从 https://qoder.cn/account/integrations 获取",
  transport: {
    baseUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    },
  },
  models: [
    { id: "ultimate", name: "Ultimate" },
    { id: "auto", name: "Auto" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "qmodel_preview", name: "Qwen3.8-Max-Preview" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash" },
    { id: "mmodel", name: "MiniMax-M3" },
  ],
  features: {
    usage: true,
    usageApikey: true
  },
};