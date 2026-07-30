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
