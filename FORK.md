# Fork 说明

## 来源

本仓库 fork 自 [decolua/9router](https://github.com/decolua/9router)（上游）。
上游版本基线：**v0.5.40**（2026-07-20，commit `79918c78`）。

## Fork 目的

原 9router 没有模拟 Codex 客户端请求的功能，导致部分只允许 Codex
客户端访问的公益站点（如 anyrouter、wuming、muyuan 等）无法通过
9router 正常代理。本 fork 在不影响原有功能的前提下，为 OpenAI 兼容
的自定义 Provider 增加了 **Codex 客户端模拟** 能力。

## 自定义改动

### 核心功能：Codex 客户端模拟（`simulateCodex`）

为 OpenAI 兼容 Custom Provider 增加逐个开关 `simulateCodex`，开启后
在出站请求中注入 Codex CLI 身份头（originator / User-Agent /
session_id / ChatGPT-Account-ID），实现纯 header 层伪装，不改动
token 和 baseUrl。

### 改动文件清单

| 状态 | 文件 | 说明 |
|------|------|------|
| **新增** | `open-sse/shared/codexFacade.js` | 核心：`applyCodexFacadeHeaders()`，被 CodexExecutor 和 DefaultExecutor 复用 |
| **新增** | `tests/unit/codex-facade.test.js` | codex 模拟头注入的单元测试 |
| 修改 | `open-sse/executors/codex.js` | 复用 codexFacade 替代内联头逻辑 |
| 修改 | `open-sse/executors/default.js` | 当 `simulateCodex === true` 时注入 codex 身份头 |
| 修改 | `src/app/(dashboard)/dashboard/providers/[id]/EditCompatibleNodeModal.js` | UI 增加「模拟 codex 客户端」开关 |
| 修改 | `src/app/(dashboard)/dashboard/providers/components/AddCompatibleModal.js` | UI 增加「模拟 codex 客户端」开关 |
| 修改 | `src/app/api/provider-nodes/[id]/route.js` | 更新路径持久化 `simulateCodex` |
| 修改 | `src/app/api/provider-nodes/route.js` | 创建路径持久化 `simulateCodex` |
| 修改 | `src/app/api/providers/route.js` | 传递 `simulateCodex` 字段 |
| 修改 | `src/lib/db/repos/nodesRepo.js` | nodesRepo 读取 `simulateCodex` |
| 修改 | `tests/unit/compatible-provider-connections.test.js` | `simulateCodex` 持久化/传播回归测试 |

向后兼容：已有节点无 `simulateCodex` 字段（读取为 undefined → false），
升级后行为不变，无需 DB 迁移（标志存储在 providerNodes.data JSON 列）。

## 分支策略

| 分支 | 用途 |
|------|------|
| `master` | 跟踪上游，保持与 `decolua/9router:master` 一致，不包含自定义改动 |
| `feat/codex-client-emulation` | codex 模拟功能的开发分支 |
| `mine` | 主工作分支，基于上游最新版本 + 自定义改动合并 |

## 上游同步流程

当上游 `decolua/9router` 发布新版本时，按以下步骤合入：

```bash
# 1. 更新 master（跟踪上游）
git checkout master
git remote add upstream https://github.com/decolua/9router.git  # 首次需要
git fetch upstream
git merge upstream/master
git push origin master

# 2. 将上游更新合入 mine
git checkout mine
git merge master
# 如有冲突，重点关注上述改动文件清单中的文件
git push origin mine

# 3. 运行测试验证
cd tests && npx vitest run unit/codex-facade.test.js
npx vitest run unit/compatible-provider-connections.test.js
```

### 合入时需重点关注的冲突区域

上游如果修改了以下文件，合并时需手动检查冲突：
1. **`open-sse/executors/default.js`** — 头注入逻辑可能与上游改动叠加
2. **`open-sse/executors/codex.js`** — 已重构为复用 codexFacade
3. **`src/app/api/provider-nodes/route.js`** 及 `[id]/route.js` — 字段持久化逻辑
4. **前端 modal 组件** — 上游可能调整 Provider 配置 UI 结构
5. **`src/lib/db/repos/nodesRepo.js`** — 字段读取逻辑

## 验证

功能已在 muyuan.do（模型 `gpt-5.6-sol`）端到端验证：
- 开关关闭 → 403 `channel:client_restricted (detected: node)`
- 开关开启 → 200 流式响应正常完成

## 本地开发

参考上游 [README.md](./README.md) 和 [CLAUDE.md](./CLAUDE.md)。

---

## Qoder CN 提供商（2026-08-28 新增）

为本 fork 加入 `qoder-cn`（alias `qdcn`）提供商，对接 Qoder 国内版
（`qoder.cn`，独立运营，与国际版 `qoder.sh` 完全分离的 endpoint 体系）。

### 关键文件

| 状态 | 文件 | 说明 |
|------|------|------|
| **新增** | `open-sse/executors/qoder-cn.js` | PAT → job token 交换 + COSY 签名 + SSE 转发 |
| **新增** | `open-sse/providers/registry/qoder-cn.js` | 提供商注册（13 模型，UI 配置） |
| **新增** | `open-sse/services/qoderModelsCn.js` | PAT 交换 + 动态 catalog 拉取 + 缓存 |
| **新增** | `open-sse/shared/qoder-cn/constants.js` | endpoint / COSY 指纹常量 |
| 修改 | `open-sse/providers/registry/index.js` | 自动重新生成（`scripts/migrate-registry.mjs`） |
| 修改 | `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js` | UI 接受 `pt-...` PAT |
| 修改 | `src/app/api/providers/validate/route.js` | 测试连接走 qoder-cn executor |
| 修改 | `src/app/api/v1/models/route.js` | qdcn/* 模型列入 `/v1/models` |
| 修改 | `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` | 配额卡片显示 |
| 修改 | `public/i18n/literals/zh-CN.json` 等 | 多语言标签 |
| 修改 | `tests/__baseline__/providers-baseline.json` / `alias-baseline.json` | 基线快照（82 providers / 117 aliases） |
| 修改 | `tests/translator/__snapshots__/golden-url-header.test.js.snap` | url/header 黄金快照 |

### 接入流程（一次性）

1. 用户去 `https://qoder.cn/account/integrations` 创建 PAT（`pt-...`）。
2. Dashboard → 提供商 → Qoder CN → 添加连接 → 粘 PAT。
3. 首次调用任一 `qdcn/*` 模型时，executor 自动：
   - PAT 换 24h job token（`jt-...`）
   - userinfo 拉 userId
   - COSY 签名 GET `/algo/api/v2/model/list?Encode=1` 拉模型目录（1h 缓存）
4. 之后的 chat 调用走 `/algo/api/v2/service/pro/sse/agent_chat_generation`，COSY 签名 + SSE 转发。

### 踩坑与排查要点

1. **endpoint 必须带 `/algo` 前缀**（2026-08-28 实测）：
   - ❌ `gateway.qoder.com.cn/api/v2/model/list` → ALB 边缘直接 503，不到应用层
   - ✅ `gateway.qoder.com.cn/algo/api/v2/model/list` → 200
   - 参考国际版： `api3.qoder.sh/algo/api/v2/model/list`（`/algo` 是 qoder 的固定 prefix）
   - chat SSE 同理： `/algo/api/v2/service/pro/sse/agent_chat_generation`

2. **不要凭猜写模型列表**。初版 registry 复制了国际版的
   `ultimate/performance/efficient/lite/qmodel_preview/kmodel_latest` 等，
   但 CN 站真实 catalog 完全不同。校准方法：用 PAT 跑一次
   `resolveQoderCnModels(..., { forceRefresh: true })` 拿到 rawConfigs
   的真实 key + display_name 后再写 registry。当前真实列表（13 个）：
   `auto, qmodel_38max, qfmodel, qmodel_latest, qmodel, q37fmodel, dmodel, dfmodel, gmodel, gfmodel, gm51model, kmodel, mmodel`。

3. **CN 与国际版的差异**：
   - 认证域 `openapi.qoder.com.cn`，推理域 `gateway.qoder.com.cn`（国际版单 host 多 subdomain）
   - CN 认证只支持 PAT，**没有 device-code OAuth**
   - CN 模型列表是 GET 带 `?Encode=1`，响应按 scene 分组（取 `body.assistant`），国际版是 POST + `body.chat`
   - CN 的 COSY 指纹必须是 CLI CN `1.1.25` + `aarch64_darwin` + clientType `5`（不能用国际版的 IDE 指纹）
   - PAT 换 job token 的 body 是 `{ personal_token: pt-... }`（不是 `{ token }`），`expires_in` 单位是**毫秒**

4. **`cli:pack` 之后必须验证 tarball 内容**：
   - size 一致 ≠ 内容一致（webpack chunk 重新哈希后大小可能差不多）
   - 验证： `tar -xzf 9router-*.tgz -C /tmp/x && grep -rl "qoder-cn\|qmodel_38max" /tmp/x/package/app/.next-cli-build/server/`
   - 如果关键字符串没进 tarball，先 `rm -rf cli/app` 再重跑 `npm run cli:pack`

5. **Google Fonts 构建被墙**：
   - 症状： `next build` 在 `src/app/layout.js` 的 `next/font/google` 卡死
   - 临时改： 把 `Inter({...})` 替换成 `const inter = { variable: "font-sans" }` 并注释 import
   - 构建完成后**必须还原**，否则后续 dev 模式字体不对

### 端到端验证记录（2026-08-28）

- PAT 创建 / 撤销 / 列出： ✅ Web UI 正常工作
- PAT → job token 交换： ✅ 返回 `jt-...` 24h 有效
- userinfo: ✅ 返回 userId `01a014d3-...`
- 模型 catalog 拉取： ✅ 13 个模型完整返回（61KB JSON）
- 13/13 模型 chat 调用： ✅ 全部返回正常 completion
- Streaming (SSE)： ✅ chunk 正常 + `[DONE]` 收尾
- 配额： 300 credits 专业试用版
- reasoning 模型（auto/qmodel/dmodel/gmodel/gm51model/kmodel）返回里有 `reasoning_content` 字段，使用 `max_tokens` 太小会全花在思考上导致 `content=""` —— 给 200+ tokens 即可

---

## ZCode / zcode2api 调研结论（2026-08-29，实测后放弃集成）

任务：评估 `liu5269/zcode2api`（把 ZCode Coding Plan 免费额度转成 Anthropic API），
能否以 OAuth / API Key 提供商形式加入 9router。

**结论：功能当前不可用，未向 9router 添加任何代码。** 证据链（全部本机实测）：

1. **OAuth init 端点活着**：`POST zcode.z.ai/api/v1/oauth/cli/init` 返回 200
   （flow_id + authorize_url）。但维护更活跃的 `TriDefender/zcode-api` 表明该
   device/poll 流程已被 auth-code 流程取代（`chat.z.ai/api/oauth/authorize` →
   `zcode.z.ai/api/v1/oauth/token`，token 响应里带 `data.token` 即 Start Plan JWT）。
2. **核心依赖「阿里无痕验证」已失效（本项目路线）**：
   - 验证码配置端点需要 `platform=win32-x64`（项目硬编码 `win32` → 400
     `parameter error`），且当前 `region` 已改为 `cn`（项目默认 `sgp`）。
   - 项目的 jsdom 求解器（`captcha_node/solver.js`）实测失败：
     `verifyResult:false, verifyCode:"F001"`。
   - 上游已封死 jsdom 路线：TriDefender/zcode-api commit `32d508d`
     “Completely migrated to Happy solver and removed jsdom dependencies”。
   - happy-dom 求解器（TriDefender 版）**可以解出**有效 `verifyParam`
     （~280 chars，含 certifyId + securityToken，1~2s），但**必须在 Bun
     运行时**（Node 26 下 happy-dom VM 根本不执行脚本）；且偶发
     pe-VM stall，需要重试池。
3. **即便拿到「有效 JWT + 有效验证码 + 官方 system 块 + ZCode 身份头」，
   上游仍整体风控拦截**：
   - `POST /api/v1/zcode-plan/anthropic/v1/messages` → 405
     `{"code":3012,"msg":"request has been blocked due to unusual activity."}`
   - `/billing/current` 等非模型端点同样 3012。
   - 本机官方 ZCode 桌面端 v3.10.1 当天日志也出现上游拒绝
     （“official MCP rejected the current credential”），且无成功模型调用
     → 3012 是账号/设备级风控，不是模拟差异。
4. **API Key 回退路线不是「免费额度」**：本机账号的 `{apiKey}.{secret}`
   组合实测 `api.z.ai` 两个端点均返回 1113 “Insufficient balance or no
   resource package”（无 Coding Plan、PAYG 余额为 0）。

**9router 集成判断**：
- API Key 形式无意义 —— 9router 已有 `glm` 提供商（`api.z.ai/api/anthropic`，
  `x-api-key`），就是这条路；1113 是账号权益问题，不是协议问题。
- OAuth 形式的价值只在 Start Plan 免费额度，但该路线被 3012 风控拦截
  （验证码只是第一道）。加进提供商列表只会制造「能登录、不能出字」的坑。
- **若上游日后解封**，集成点已摸清：`registry/zcode.js`（`format: "claude"`，
  baseUrl `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`）+
  专属 executor（ZCode 身份头 + trace 头 + `X-Aliyun-Captcha-Verify-Param`
  注入 + 3007/3012 判定重试）+ OAuth service（auth-code 流程，把
  `data.token` 存为 accessToken）+ Bun 侧独立验证码求解进程。
  验证脚本留存于 `~/work/hermes/api/zcode-api/test-*.ts`（用 `bun` 运行）。
