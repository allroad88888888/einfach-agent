PASS

# 080 独立审查

## 结论

- 未发现需要返修的 080 问题。基线
  `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 与当前 `HEAD` 一致；6 个指定 MCP
  文件的 scoped diff 仅有 5 个产品文件变更，`McpCredentialField.tsx` 无 diff。
- 固定 label、action、description、placeholder、status、`aria-label`、`title`
  与受控插值框架均使用 Lingui v6 `@lingui/react/macro` 的 `Trans` 或
  `useLingui().t`；项目锁定 `@lingui/react` / `@lingui/core` 6.6.0，19 个专项
  Vitest 也已完成 macro 转换。
- 动态 MCP 数据保持原样：server name、URL/target、headers/env 键值、command/args/cwd、
  诊断错误和历史 probe 摘要都未被当作 message 翻译；名称、路径和数量只放入
  受控的固定插值框架。
- 未发现表单校验、connect/reconnect/disconnect/remove、持久化、stdio launch
  consent 或 Einfach 状态行为改动；未引入 React 本地产品状态、新 atom 或其他状态库。

## 核验证据

- `McpSettingsPanel.tsx:40-70,93-97` 的标题、说明、操作、存储状态、恢复状态和
  空态均进入 Lingui；`importStatus` 与 `hydration.error` 在 `:66-74` 仍直接渲染。
- `McpAddServerForm.tsx:40-281` 覆盖表单 label/action/description/placeholder/aria 和
  分支状态；`draft.name/url/headersText/command/argsText/cwd/envText`、`jsonDraft`、
  `validation.errors.*` 与 `formError` 的 value/error 通道及所有 commands 调用未改。
  `TRANSPORT_OPTIONS` 仅把固定显示 label 移到 render 内翻译；两个 value、顺序、stdio
  disabled 条件和切换 stdio 时关闭 `autoConnect` 的逻辑不变。
- `McpCredentialField.tsx:16-54` 无自有可见固定文案；`label`/`placeholder`/
  `formatHint`/`disabledHint` 由已迁移的调用方传入，value/error/onChange 仍原样透传，
  因此无需修改该文件。
- `McpServerCard.tsx:52-185` 将固定 status/note/hint/action/aria/title 放入组件内生成
  Lingui message；原 `statusLabel` / `statusNote` / `autoConnectHint` 分支语义保持一致。
  `server.name/target/args/cwd/error` 仍在 `:89-154` 以原值渲染或插值，四个 MCP
  command 的调用参数、busy/disabled/transport/consent 条件未改。
- `McpLaunchConsentPrompt.tsx:19-51` 只翻译确认框架；`request.name/commandLine/cwd`
  及 `envNames` 内容仍是原始值，环境变量值仍不显示，approve/dismiss 调用不变。
- `McpServerToolSummary.tsx:15-23` 仅把已连接工具数改为受控插值；未连接时仍直接使用
  `describeLastKnownTools(lastKnown)` 和 `formatProbedAtExact(lastKnown.cachedAt)`，未改 probe 数据或
  历史描述逻辑。
- Einfach 护栏扫描未命中 `useState` / `useReducer` / render 内创建 `atom(...)` 或第三方
  状态库；原有 `useAtomValue` 订阅边界保持不变。

## 独立命令结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/McpServerCard.test.tsx apps/web/src/agentNew/ui/SettingsCenter.mcp.test.tsx`
   - exit 0；2 files passed，19/19 tests passed。
2. `pnpm exec tsc -b --pretty false`
   - exit 2；仅有任务外 ModelConnection 测试的 3 个类型错误：
     `modelConnectionProfileCommands.test.ts:90` 的 `manual`/`discovered` 字面量不兼容，
     以及 `settingsCenterCommands.test.ts:24,31` 的旧 `model`/新 `models` 契约漂移。
     输出不含 080 的 6 个 MCP 文件，属任务外阻塞，不改变 PASS 结论。
3. `git diff --check -- <six MCP files>`
   - exit 0，无输出。scoped status 仅列出 5 个修改文件，
     `McpCredentialField.tsx` 无变更。
4. `wc -l <six MCP files>`
   - `103 / 191 / 286 / 57 / 56 / 25`，全部 ≤ 300；`McpAddServerForm.tsx` 为
     286 行。六文件仍分别负责面板编排、单服务卡、添加表单、凭据字段、启动确认与工具摘要，
     未扩张文件职责。

## R1

无。不需要返修。

## 范围声明

审查未修改产品、测试、PO/catalog、任务定义、index 或执行报告；本次唯一写入是
`reports/080-review.md`。
