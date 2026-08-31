# 070 执行报告：审核模型中心边界

## 改动摘要

- `connectionProfileProbe.test.ts` 补充直接 302 响应回归，断言 `redirect: 'manual'`、不跟随跳转、错误不泄漏 Key 或 Location；补充恰好 1,000/1,001 个模型与 200/201-byte 模型 ID 的边界。
- `modelConnectionProfileManifest.test.ts` 补充根级未知字段与 `connection.id` 的直接拒绝断言。
- 新增 `ModelConnectionProfileSettings.test.tsx`，使用完全可控的 fake `FileReader` 直接挂载绑定层：合法 manifest 只预填 label/baseUrl/models 且 Key 为空；含 `apiKey`、未知字段及读取错误均保持编辑器打开并显示通用错误。
- 未修改产品代码；新增/修改测试文件仍各自只负责一个测试域，全部低于 300 行。

## 逐条验收命令与结果

### 1. 跨层安全 Vitest

命令：

```sh
pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts apps/web/src/modelTransport/providerRoute.test.ts apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx apps/web/src/agentNew/ui/ModelConnectionProfileSettings.test.tsx apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/modelConnectionProfileManifest.test.ts packages/host-node/src/model/connectionProfileProbe.test.ts packages/host-node/src/model/connectionProfileForward.test.ts packages/host-node/src/model/connectionProfileForwardBinding.test.ts
```

结果：通过，9 个测试文件、87 个测试全部通过。

断言与覆盖归属：

- 旧 `{ model }` 迁移为唯一模型：010 上游命令已覆盖 `connectionProfileValidation/Transaction/Commands`；本卡未重复其专用命令。删除所选模型后默认运行时安全回退由本次 `modelConnectionProfileCommands.test.ts` 覆盖；删除整个连接后仅在 host 成功后清默认由 `ModelCredentialPanel.connections.test.tsx` 覆盖。
- 同 Base URL 的两个 profile：本次 `connectionProfileForward.test.ts` 断言各自服务端 Key 隔离；`ModelCredentialPanel.connections.test.tsx` 与 `providerRoute.test.ts` 断言 transport/session 只携带 `connectionId` 和所选模型，不携带 URL/Key。
- probe 密钥边界：本次 probe、commands、绑定层测试覆盖 Key 仅进入请求 header、公开模型结果不含 Key、网络/非 2xx/302/超时/畸形响应错误受控、失败不替换草稿模型且不写配置；020 上游命令另已覆盖严格命令入参与无配置写入。
- manifest：本次 parser 与绑定层测试覆盖秘密/未知字段拒绝、根级未知字段、`connection.id`、成功导入后 Key 为空，以及读取/解析失败保持编辑器打开。
- 静态/官方/legacy：本次 `ModelCredentialPanel.connections.test.tsx` 覆盖静态部署隐藏第三方管理、官方 DeepSeek 与 legacy 入口仍分组展示；`builtinProviders.test.ts` 和 `providerRoute.test.ts` 覆盖官方 adapter 身份及第三方同名模型仍走 `openai-compat`。
- 020 审查 Minor 已消化：直接构造 302；恰好 1,000 接受、1,001 拒绝；200-byte 接受、201-byte 拒绝。
- 050/060 审查 Minor 已消化：根级未知字段与 `connection.id` 显式拒绝；fake FileReader 合法、秘密/未知字段、读取错误绑定层覆盖。

### 2. 类型、状态、边界、生产构建与 diff 门

命令：

```sh
pnpm exec tsc -b && pnpm check:state && pnpm check:boundaries && pnpm exec vite build --config vite.config.ts && git diff --check
```

结果：最终复跑全部通过。

- 首次执行由新增 302 fake fetch 的空参数元组推断导致 TypeScript 失败；为 fake 补充标准 fetch 参数签名后完整复跑通过。
- `check:state`：通过，扫描 869 个非测试 TS/TSX 文件。
- `check:boundaries`：通过，扫描 884 个非测试 TS/TSX 文件；输出仅含已有豁免观察项。
- Vite production build：通过，1235 modules transformed；输出既有动态/静态 import 与大 chunk 警告，不是本任务测试改动引入的失败。
- `git diff --check`：通过。
- 上游已声明并记录的命令包括 010 host profile 5-file Vitest、015 provider/endpoint Vitest 与 AI build、020 probe/command/host Vitest 与 host build、030/035 commands/state Vitest、040 preset Vitest、050 manifest Vitest、060 UI Vitest/tsc/check:state、065 fixture Vitest/tsc；本卡依任务验收仅运行跨层组合总门及完整最终门，不另行逐条重复这些上游专用命令。

### 3. 密钥字面审计

命令：

```sh
rg -n "apiKey|Authorization|Bearer" apps/web/src/agentNew/ui apps/web/src/settings/modelConnectionProfile*
```

结果：逐项审计通过。

- `modelConnectionProfileState.ts` 的 `apiKey` 仅为非持久化编辑器密码草稿；打开编辑、取消、成功保存、删除及关闭时清空。
- `modelConnectionProfileCommands.ts` 仅把草稿 Key 写入 write-only save 或当前 probe 请求；hydrate/list/read 的公开 profile 无 Key。
- `modelConnectionProfileHost.ts` 明确限定 Key 为 write-only save/probe 输入，公开 profile/result 类型不含 Key。
- UI 命中仅为密码输入绑定与 preset/manifest 成功后显式清空；没有 profile 卡片、列表、导入结果或 transport envelope 持久化 Key。
- 测试命中用于构造秘密拒绝场景、验证临时参数及断言输出不含秘密。
- `McpAddServerForm`、`SettingsCenter.mcp.test.tsx` 的 Authorization/Bearer 命中属于独立 MCP server header 功能，不属于模型连接 profile 边界。

### 4. 文件职责与行数

命令：对任务 files 执行 `wc -l`。

结果：通过。目标文件分别为 231、91、219、89、144、91、140 行，均低于 300 行；新增绑定层测试文件仅负责 manifest/FileReader 绑定回归。

## 未验证项

- 未连接真实第三方端点，遵守禁止真实联网的全局约束；所有 probe 使用注入 fetch。
- 未做桌面/移动浏览器截图或人工视觉检查；本任务是安全边界回归叶，行为由 jsdom 绑定层和组件测试覆盖。
- 未单独重跑上游报告中每一条专用命令；已读取并记录其通过证据，本卡运行了任务指定的跨层组合及最终总门。

## 范围外发现

- Vite 仍输出多个模块同时静态与动态导入、主 chunk 超过 500 kB 的既有警告；与本任务测试改动无关，未修改。
- `rg` 搜到 MCP server 表单允许用户输入 Authorization/Bearer header；这是独立 MCP 配置域，不是模型连接 profile 数据流，未修改。
- 工作区目标测试多数为前序任务留下的未跟踪文件；本卡保留其状态，未暂存或提交。

## 疑虑

- 无模型中心密钥边界的已知功能性疑虑。
- 视觉布局仍只有组件/jsdom 与 CSS 证据，没有真实浏览器截图证据。

## 建议后续动作

1. 编排者终审时确认所有前序未跟踪产品与测试文件均被纳入最终变更集。
2. 若发布门要求视觉证据，在可注入本机 profile host 的浏览器 harness 中补桌面/移动截图；不要为此放宽 Key 或网络边界。
3. Vite chunk 警告可在独立性能任务中评估，不与模型中心安全终审混改。
