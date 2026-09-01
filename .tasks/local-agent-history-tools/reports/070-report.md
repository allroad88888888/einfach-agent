# 070 执行报告

状态：实现完成，等待父任务复核。

## 交付

- core persistence 依赖新增可选 `AgentHistoryCapabilityProvider`。`buildToolContext` 在解析
  `workspaceRoot` 后绑定 provider；缺席时不挂 `agentHistory`。默认 Core、独立 Core、递归
  `callTool` 均保持实例隔离。
- CLI 复用一个 SQLite executor、一个 rollout driver、一个 recovery facade 创建 provider。
  core persistence 与 Node host routes 借用同一 provider identity。history 不增加 disposer；唯一
  persistence disposer 仍按 recovery → rollout 顺序 flush。
- Web server bundle 通过四条 host command 提供 workspace-bound adapter。legacy root 只在 runtime
  envelope 中注入。static Web 不创建 adapter，ToolContext 保持 capability 缺席。既有 rollout source
  startup fence 继续先于 hydrate/render。
- 新增并注册 `list_agent_histories`、`list_agent_history_items`、`read_agent_history_item`、
  `search_agent_histories`。四项使用严格 object schema、严格 root/child union、稳定 unavailable、typed
  provider failure 映射。structured result、warnings、cursor 原样保留。四项均为 replay-safe internal
  read，不进入 dangerous/workspace/verification 分类。
- `delegate_only`、`workspace_read`、`workspace_verify` 的 manifest 与真实 execution gate 均开放四项。
  该路径不依赖 confirmed/approval/permission/ancestor capability。未知 profile 在 manifest 与 execution
  gate 两侧均 fail closed；其它工具能力不提升。
- 新增一页运维文档，说明本机全局可见性、JSONL canonical source、SQLite read model、FTS derived
  index、targeted legacy partial、static Web unavailable、分页限制、错误边界。rollout 文档只增加入口链接。

## 单一职责核对

- `historyCapabilities.ts` 只绑定当前 ToolContext 的 history capability。
- CLI `historyCapability.ts` 只用宿主已有依赖创建 Node provider。
- CLI `persistence.ts` 只装配 CLI persistence 生命周期。
- Web `serverAgentHistoryCapability.ts` 只适配四条 server command。
- 四个 tool 实现文件各自只定义一个模型工具。
- `historyToolProfile.ts` 只持有 child history 工具常量与 profile 谓词。
- 新增测试文件各自只验证对应装配边界。
- 新增文档只描述 history tools 的运行契约。

## 验证

- 最终 focused Vitest：17 files / 64 tests PASS。覆盖 capability 缺席、多 Core 隔离、递归 callTool、
  CLI identity/disposer/startup、Web server/static/startup fence、四工具 schema/透传/错误、三档 child
  manifest/execution gate、未知 profile fail-closed、standard registry 无重复。
- `pnpm exec tsc -b --pretty false`：PASS。
- `pnpm --filter @einfach-agent/tools-agents build`：PASS。
- `pnpm --filter @einfach-agent/host-node build`：PASS。
- `pnpm exec vite build --config vite.config.ts`：PASS；仅输出仓库既有 dynamic-import/chunk-size warnings。
- `pnpm check:boundaries`：PASS；仅输出仓库既有观察项。
- `pnpm check:state`：PASS。
- `git diff --check`：PASS。
- 070 owner 全部 `<=300` 行；最大为 `persistenceBridge.ts` 254 行，其次为 `main.tsx` 240 行。

## Owner 与工作树

- 产品、测试、文档修改均落在 070 frontmatter 的 `files` 清单内。
- `tools/standard/src/index.ts` 仅把陈旧的标准工具总数注释从 32 更新为 36。
- `packages/agent-core/src/subagents/prompt.ts` 仅更新三档 profile 提示，使文字与已开放工具一致。
- 未修改任务状态、任务索引或其它 report；保留前置 rollout 与 dirty worktree 改动。

## 已知的非 070 构建阻断

- `pnpm --filter @einfach-agent/core build` 的 tsup 阶段通过，随后在非 owner
  `src/state/persistence/modelMigration.ts:25` 遇到既有 `DeepSeekReasoningEffort` 类型不兼容。010 report
  已记录同一问题；全仓 `tsc -b` 本轮通过。
- `pnpm --filter @einfach-agent/tools build` 的 tsup 阶段因本地 `tools/standard/node_modules` 缺少
  `@einfach-agent/tools-vision` workspace symlink 而无法解析该包。tools-agents、host-node、Web production
  build 与全仓类型检查均通过；未运行会改写 lockfile/node_modules 的广域安装。

## 运行边界

- static Web 返回 `AGENT_HISTORY_UNAVAILABLE` 是设计结果，不是空历史。
- global list/search 只读 canonical catalog/FTS。指定 target 缺少 canonical 记录时才读取 legacy，结果可能
  携带 `LEGACY_PARTIAL_HISTORY`。

## R2：Web typed history error 透传

- core history 合同新增唯一闭合集合 `AGENT_HISTORY_ERROR_CODES`，`AgentHistoryErrorCode` 由该 tuple
  推导。`isAgentHistoryErrorCode()` 为 server mapper 与 Web adapter 提供同一 runtime 判据，未改变既有
  error code 集合。
- server invoke mapper 只在 `error.code` 命中该闭合集合时透传 history code。合法 history wire shape
  同样可识别；未知或未来 code 仍落 `command_failed`。MCP kind/verdict、model reason、dispatch 404/501、
  普通 command failure 的既有映射保持不变。
- Web history adapter 的生产默认改用 `invokeServerCommand` 结构化调用面。只有带合法 history code 的
  `ServerInvokeError` 会重建成 `AgentHistoryError`；网络失败、未知 code、普通 command failure 保持普通
  Error 路径。注入的 `HostInvoke` seam 经过相同映射。通用 `httpInvoke` 仍维持 Tauri-compatible 裸字符串
  rejection 合同。
- 端到端测试以真实 `mapInvokeRouteError()` 生成 HTTP error envelope，再经过真实
  `invokeServerCommand`、生产默认 Web adapter、实际 `list_agent_histories` execute。`INVALID_CURSOR` 与
  `SOURCE_CORRUPT` 均保留原 code 且 `retryable:false`；未知 history-like code 变为
  `AGENT_HISTORY_QUERY_FAILED` 且 `retryable:true`。生产默认成功 envelope 的 warnings/cursor identity
  同样覆盖。

### R2 验证

- R2 紧邻 focused Vitest：5 files / 52 tests PASS。
- 扩展 070 focused Vitest：20 files / 111 tests PASS。
- `pnpm exec tsc -b --pretty false`：PASS。
- `pnpm --filter @einfach-agent/tools-agents build`：PASS。
- `pnpm exec vite build --config vite.config.ts`：PASS；仅输出仓库既有 warnings。
- `pnpm --filter @einfach-agent/server build`：PASS；成功嵌入本轮 Web dist。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：PASS。
- 全部 070 owner `<=300` 行。R2 触及的最大文件为 core `historyQuery.ts` 169 行；全任务最大仍为
  `persistenceBridge.ts` 254 行。
- core 完整 package build 的既有 `modelMigration.ts:25` 类型阻断不变；本轮先刷新 runtime dist，再用
  `tsc --noEmitOnError false` 生成声明供下游构建。源码权威门禁 `tsc -b` 通过，未修改该非 owner 文件。
- 未修改任务状态或任务索引，未扩展查询/FTS/transport 架构。
