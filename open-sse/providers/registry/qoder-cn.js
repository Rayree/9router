/**
 * Qoder CN (国内版) registry entry.
 * Based on the international Qoder provider but pointing to qoder.cn endpoints.
 *
 * Key differences from international version:
 * - Uses qoder.cn domain with /api path prefix instead of qoder.sh subdomains
 * - OAuth login at qoder.cn/device/selectAccounts
 * - API endpoints at qoder.cn/api/v1/... and qoder.cn/api/v2/...
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
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) 从 https://qoder.cn/account/integrations 获取",
  transport: {
    baseUrl: "https://qoder.cn/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://qoder.cn/api/v2/quota/usage",
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
  oauth: {
    openApiBaseUrl: "https://qoder.cn",
    centerBaseUrl: "https://qoder.cn",
    chatBaseUrl: "https://qoder.cn",
    deviceTokenUrl: "https://qoder.cn/api/v1/deviceToken/poll",
    refreshUrl: "https://qoder.cn/api/v3/user/refresh_token",
    userInfoUrl: "https://qoder.cn/api/v1/userinfo",
    quotaUsageUrl: "https://qoder.cn/api/v2/quota/usage",
    loginUrl: "https://qoder.cn/device/selectAccounts",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
