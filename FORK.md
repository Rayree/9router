# Fork 说明

## 来源

本仓库 fork 自 [decolua/9router](https://github.com/decolua/9router)（上游）。
上游版本基线：**v0.5.40**（2026-07-20，commit `79918c78`）。
最近同步：**v0.5.112**（2026-11-01，upstream/master `1fe586bb`，257 个上游 commit，
fast-forward master + merge 进 mine）。合并前先移除了 fork 自研的 qoder-cn（上游
v0.5.85 已自带同 id 实现，见下方「Qoder CN」节），冲突因此从 13 个降到 2 个，均为双保留：
`executors/codex.js`（上游新增 `x-openai-internal-codex-responses-lite` 头 + 当时 fork 的
`applyCodexFacadeHeaders`）、`executors/default.js`（fork 的 403 `ide_request_blocked`
重试 override + 上游新版 `transformRequest`/`applyNousAttribution`）。
同日随后移除了 `simulateCodex`，改用上游的 Custom Headers（见「Codex 客户端模拟」节），
`codex.js` 已回到上游版本。
上一次同步：v0.5.81（2026-09-19，`a8c9d380`，零冲突）。

## Fork 目的

最初目的是让只允许 Codex 客户端访问的公益站点（如 anyrouter、wuming、muyuan、
hiyo 等）能通过 9router 代理，为此加了 `simulateCodex` 开关。上游 v0.5.95 起自带
按 provider 设置请求头的功能，该开关已于 2026-11-01 移除，改为在上游卡片上加
「Codex 客户端」一键预设。现在 fork 只保留几处上游没有的修复和这个预设按钮，见下表。

## 自定义改动

| 改动 | 文件 | 说明 |
|------|------|------|
| 403 渠道拦截透明重试 | `open-sse/executors/default.js`（`execute()` override）、`open-sse/config/errorConfig.js`、`tests/unit/compatible-ide-blocked-retry.test.js` | 多渠道 new-api 中转对部分渠道返回 403 `ide_request_blocked` 时原样重放最多 2 次（换渠道），并把该错误的冷却从 2 分钟降到 5 秒 |
| Responses 节点非流式修复 | `open-sse/handlers/chatCore/nonStreamingHandler.js`、`open-sse/transformer/streamToJsonConverter.js`、`tests/unit/openai-responses-nonstream.test.js`、`tests/unit/compatible-responses-nonstream-routing.test.js` | 详见文末「hiyo.top 非流式修复」节；`chatCore.js` 已于 2026-11-01 恢复上游版本 |
| 国内网络探测 | `src/lib/tunnel/shared/internetCheck.js`、`src/lib/tunnel/shared/dnsResolver.js` | 联网检查与 DNS 用 223.5.5.5 替代 1.1.1.1 |
| Custom Headers「一键设置」 | `src/app/(dashboard)/dashboard/providers/[id]/headerPresets.js`、`CustomConfigCard.js`、`tests/unit/header-presets.test.js` | compat 节点显示 Custom Headers 卡片，并提供「Codex 客户端」预设按钮，见「Codex 客户端模拟」节 |
| 文档 | `FORK.md`、`CLAUDE.md` 顶部 fork 规则、`AGENTS.md`（→ `CLAUDE.md` 软链接） | |

## Codex 客户端模拟（改用上游 Custom Headers）

上游 `b3cf3fde`（v0.5.95）在 provider 详情页底部加了 **Custom Headers** 卡片，
按节点保存到 `settings.providerOverrides`，在 `BaseExecutor.execute` 里最后合并，
同名头会覆盖内置值。但上游的卡片在「没有内置头且没有已保存覆盖」时直接
`return null`，**OpenAI Compatible 节点在纯上游版本里看不到这个卡片**
（API `PUT /api/providers/{id}/overrides` 本身接受 compat 节点）。

fork 为此加了「一键设置」按钮：compat 节点（`openai-compatible-*`）的详情页
总会显示 Custom Headers 卡片，标题下有 **Codex 客户端** 按钮，点一下把下面两个头
写入表格并立即保存（已有的同名头会被替换，其他自定义头保留）：

| Header | Value |
|--------|-------|
| `originator` | `codex_cli_rs` |
| `User-Agent` | `codex_cli_rs/<CODEX_CLI_VERSION>`（2026-11-01 为 `0.159.0`） |

取值直接读 `open-sse/providers/registry/codex.js` 的 `transport.headers`，上游
升级 Codex 版本号时按钮跟着变。实现：`src/app/(dashboard)/dashboard/providers/[id]/headerPresets.js`
（预设定义 + 合并逻辑）、同目录 `CustomConfigCard.js`（显示条件、按钮、`save(nextRows)`），
测试 `tests/unit/header-presets.test.js`。

限制：头名只允许字母、数字和 `-`，所以 **`session_id` 设不了**；`Authorization`、
`Cookie`、`Host` 等被禁止覆盖。以前的 `simulateCodex` 还会自动带 `session_id`
（按连接 id）和 `ChatGPT-Account-ID`（第三方中转一般没有）。

2026-11-01 实测（`gpt-5.6-luna` @ free.hiyo.top，经 DefaultExecutor 直发）：

| 请求头 | 结果 |
|--------|------|
| 不加 | 200，正文为拒绝文案「本站该模型仅限指定客户端使用……请使用 Codex CLI / Codex 桌面版 后重试」 |
| `originator` + `User-Agent`，无 `session_id` | 200 `pong`，流式与非流式都正常 |

同时测的 fengwind（526）、bohr / jianzhile（503 无可用渠道）、hyb（401 令牌无效）
在加不加模拟头时结果完全相同，是站点自身问题，不能说明是否需要 `session_id`。
如果以后遇到加了上面两个头仍被识别为非 Codex 客户端的站点，可能是它校验
`session_id`，届时需要在 fork 里重新加回自动注入。

库里 `providerNodes.data` 中残留的 `simulateCodex: true` 字段不再被读取，无害。

## 分支策略

| 分支 | 用途 |
|------|------|
| `master` | 跟踪上游，保持与 `decolua/9router:master` 一致，不包含自定义改动 |
| `mine` | 主工作分支，基于上游最新版本 + 自定义改动合并 |
| `feat/codex-client-emulation` | 已过时：simulateCodex 的开发分支，功能已移除，不再维护 |

## 上游同步流程

当上游 `decolua/9router` 发布新版本时，按以下步骤合入：

```bash
# 1. 更新 master（跟踪上游）
git checkout master
git remote add upstream https://github.com/decolua/9router.git  # 首次需要
git fetch upstream
git merge --ff-only upstream/master
git push origin master

# 2. 将上游更新合入 mine
git checkout mine
git merge master
# 如有冲突，重点关注下方列出的文件
git push origin mine

# 3. 运行测试验证
cd tests && npx vitest run unit/compatible-ide-blocked-retry.test.js unit/openai-responses-nonstream.test.js \
  unit/compatible-responses-nonstream-routing.test.js unit/header-presets.test.js
```

全量测试在纯上游 master 上本来就有 30 个左右失败，判断回归要对比 master 的失败集合，
不能只看总数。

### 合入时需重点关注的冲突区域

上游如果修改了以下文件，合并时需手动检查冲突：
1. **`open-sse/executors/default.js`** — fork 的 `execute()` override（403 `ide_request_blocked`
   透明重试）可能与上游改动叠加
2. **`open-sse/config/errorConfig.js`** — `ERROR_RULES` 里的两条短冷却规则
3. **`open-sse/handlers/chatCore/nonStreamingHandler.js`**、**`open-sse/transformer/streamToJsonConverter.js`**
4. **`src/app/(dashboard)/dashboard/providers/[id]/CustomConfigCard.js`** — fork 改了
   `return null` 的显示条件、`save` 的参数和标题下的预设按钮行；另外留意上游是否改了
   `codex.js` 里 `transport.headers` 的结构（`headerPresets.js` 依赖它）

## 本地开发

参考上游 [README.md](./README.md) 和 [CLAUDE.md](./CLAUDE.md)。

---

## Qoder CN（2026-11-01 起改用上游实现）

fork 曾在 2026-08-28 自研 `qoder-cn`（alias `qdcn`）。上游 v0.5.85（`402745dc`，
2026-09-21）合入了同 id / 同 alias 的实现，并同时支持 OAuth 和 PAT（`pt-...`）两种
认证，因此 fork 版本已在 `6578e432` 中整体移除，现在完全使用上游代码。已用 PAT
添加的 qoder-cn 连接在上游实现下仍按 apikey 模式工作，无需重建。

与 fork 版本的差异，出问题时可作排查依据：
- 模型目录：fork 实测（2026-08-28）CN 站真实目录为 13 个：`auto, qmodel_38max,
  qfmodel, qmodel_latest, qmodel, q37fmodel, dmodel, dfmodel, gmodel, gfmodel,
  gm51model, kmodel, mmodel`。上游 registry 另列了 `ultimate/performance/efficient/
  lite/kmodel_latest`，缺 `q37fmodel/gm51model`；以 Dashboard「Fetch Qoder Models」
  拉取的实时列表为准。
- 10605 排队：上游按 qodercli 的做法轮询队列状态后再重放，默认最长等 10 分钟，
  环境变量为 `QODER_MODEL_QUEUE_MAX_WAIT_MS`；fork 旧的 `QODER_CN_QUEUE_RETRY_MAX_MS`
  / `QODER_CN_QUEUE_RETRY_MAX_ATTEMPTS` 已失效。

## 构建与打包踩坑（通用）

1. **`cli:pack` 之后必须验证 tarball 内容**：
   - size 一致 ≠ 内容一致（webpack chunk 重新哈希后大小可能差不多）
   - 验证：`tar -xzf 9router-*.tgz -C /tmp/x && grep -rl "<本次改动的关键字符串>" /tmp/x/package/app/.next-cli-build/server/`
   - 如果关键字符串没进 tarball，先 `rm -rf cli/app` 再重跑 `npm run cli:pack`

2. **Google Fonts 构建被墙**：
   - 症状：`next build` 在 `src/app/layout.js` 的 `next/font/google` 卡死
   - 临时改：把 `Inter({...})` 替换成 `const inter = { variable: "font-sans" }` 并注释 import
   - 构建完成后**必须还原**，否则后续 dev 模式字体不对

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

---

## hiyo.top 非流式修复 + 端到端验证（2026-09-07）

开源公益 Codex 中转站 `free.hiyo.top`（Codex 订阅站）实测接入成功。
该站与 muyuan 同类：`/v1/responses` 校验客户端指纹，非 Codex 客户端
返回 HTTP 200 但正文是「仅支持 Codex 官方客户端」的拒绝文案（伪装成
正常回复，非报错）。指纹校验实测规则：**`originator: codex_cli_rs` 或
codex 系 User-Agent 任一命中即放行**（curl 默认 UA + originator 也过）。
当时用 `simulateCodex` 开关接入（现已改用 Custom Headers），过程中暴露出非流式路径
两个 bug，已修复。这些修复与客户端模拟无关，仍保留在 fork 中。

### 端到端验证记录（2026-09-06/07，站点 key `sk-6bca...748d6`）

| 路径 | 结果 |
|------|------|
| `/v1/chat/completions` stream=false | ✅ content 正常 + usage（prompt 含 `prompt_tokens_details.cached_tokens`） |
| `/v1/chat/completions` stream=true | ✅ 增量 delta 正常 |
| `/v1/responses` stream=true（透传） | ✅ 全事件流 + usage |
| `/v1/responses` stream=false（聚合） | ✅ 聚合出 output/usage |

模型：`gpt-5.6-luna`（该 key 仅此一个）；上游延迟 1~60s，间歇性
Cloudflare 502（站点自身容量问题，与客户端指纹无关）。

### 修复的 bug

| 文件 | 问题 | 修复 |
|------|------|------|
| `open-sse/handlers/chatCore.js`（**已撤销**，见下方说明） | 自定义节点不在 `PROVIDERS`，`PROVIDERS[provider]?.forceStream` 恒为 false；但请求翻译器 `openaiToOpenAIResponsesRequest` **硬编码 `stream: true`**，上游永远回 SSE → 非流式客户端的 Responses SSE 被 `parseSSEToOpenAIResponse`（chat 解析器）错误解析 → 空 content | compatible-responses 节点（`resolveOpenAICompatibleApiType() === "responses"`）与 codex 一致视为强制流式，统一走 forced-SSE 聚合路径 |
| `open-sse/transformer/streamToJsonConverter.js` | 聚合只认 `response.output_item.done` 事件，但 hiyo 从不发该事件（完整 `output` 只在 `response.completed` 里）→ 聚合结果 `output: []` | `completed` 时若 `items` 为空，采纳 `response.output` 数组 |
| `open-sse/handlers/chatCore/nonStreamingHandler.js` | `translateNonStreamingResponse` 只有「chat 上游 → responses 客户端」分支，缺反向（responses 上游真回 JSON 时 chat 客户端拿不到 content） | 新增 `openAIResponsesCompletionToChat()`：message/reasoning/function_call → choices[0].message，usage 含 cached_tokens |

回归测试：`tests/unit/openai-responses-nonstream.test.js` 新增 4 个用例
（hiyo bug describe）。

**2026-11-01 撤销 chatCore.js 的改动。** 上游 `b00ba1aa`（2026-10-07）在
`chatCore.js` 里把 `providerResponseFormat === FORMATS.OPENAI_RESPONSES` 也送进
forced-SSE 聚合分支，覆盖了上面那一行要修的场景（chat / claude 非流式客户端 →
responses 节点）。fork 的强制流式反而造成了新 bug：Responses 客户端非流式调用
responses 节点时请求不经翻译，发给上游的仍是 `stream:false`，上游回 JSON，网关
却当成流转发，客户端收到 `text/event-stream` 的 `<json>data: [DONE]`。不带
`stream` 字段、`Accept: application/json` 的 SDK 请求同样中招（fork 的判断还屏蔽了
Accept 分支）。现在 `chatCore.js` 与上游一致，回归测试在
`tests/unit/compatible-responses-nonstream-routing.test.js`（真实 `handleChatCore`，
模拟上游按 `stream` 决定回 SSE 还是 JSON）。

### 踩坑要点

1. **hiyo 的拒绝是「成功响应」形态**：HTTP 200 + `output_text.delta` 里的
   拒绝文案，9router 会原样透传给客户端——排查「模型说怪话」时先确认
   站点是否认出了客户端，别只看状态码。
2. **hiyo 不发 `response.output_item.done`**，聚合器别只依赖逐 item 事件。
   （2026-11-01 复测时 hiyo 已开始发该事件，也会按 `stream:false` 回 JSON；
   兜底逻辑保留给其他不发该事件的中转。）
3. **`openaiToOpenAIResponsesRequest` 强制 `stream: true`** 是上游原始设计
   （codex 后端只收流式），但只作用于经过翻译的请求。Responses 客户端直连
   responses 节点时不翻译，`stream` 原样透传，上游可能回 JSON。所以只能对
   「翻译后确实是流式」的请求走 forced-SSE 聚合，不能按节点类型一刀切
   （上游 `chatCore.js` 现在就是这样判断的）。
4. **接入站点配置**：添加 OpenAI Compatible 节点 → API Type 选
   Responses API → 在节点页 Custom Headers 卡片点「Codex 客户端」
   （见「Codex 客户端模拟」节）→ baseUrl 填站点根（如
   `https://free.hiyo.top/v1`）→ 连接填站点 key → 模型用站点 `/v1/models`
   实际返回的 id。
