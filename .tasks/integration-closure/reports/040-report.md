# 040 工具上下文类型拆分报告

状态：DONE

## 变更

- 新建 `shellCommandTypes.ts`，专门定义 `ShellPlatform`、`ShellCommandInput`、`ShellCommandResult`。
- 新建 `visionToolTypes.ts`，专门定义 workspace 图片读取与 app-owned vision capability 的值对象。
- `types.ts` 以 type-only import 组装 `ToolContext`，并从原公开路径 re-export 全部 Shell/Vision 类型。
- 所有字段、可选性、联合字面量与注释语义保持不变；未修改 consumer import、运行时行为、schema 或协议。

## 验证

- `pnpm exec tsc -b --pretty false`：通过，退出码 0。
- 相关 agent-core 测试：
  - `packages/agent-core/src/runtime/hostPlatform.test.ts`
  - `packages/agent-core/src/runtime/shellCommand.backgroundKill.test.ts`
  - `packages/agent-core/src/runtime/toolContext.test.ts`
  - `packages/agent-core/src/runtime/toolContext.verifyProfile.test.ts`
  - `packages/agent-core/src/runtime/toolContext.workspaceRoot.test.ts`
  - `packages/agent-core/src/runtime/toolContext/visionCapabilities.test.ts`
  - `packages/agent-core/src/tools/registry.test.ts`
  - 结果：7 files / 63 tests passed，退出码 0。
- `pnpm check:state`：通过；扫描 22 个 workspace、902 个非测试 TS/TSX 文件，5 条规则。
- `pnpm check:boundaries`：通过；扫描 918 个非测试 TS/TSX 文件，7 条规则，仅有已登记观察项。
- 范围 `git diff --check`：通过，退出码 0。
- `wc -l`：`types.ts` 299 行、`shellCommandTypes.ts` 31 行、`visionToolTypes.ts` 39 行。

## 单一职责

- `types.ts`：定义工具框架总契约。
- `shellCommandTypes.ts`：定义 Shell 命令调用的值对象。
- `visionToolTypes.ts`：定义受限图片读取与视觉调用的值对象。

三文件均可独立描述职责且不超过 300 行，无假拆分或数字后缀。

## 关注项

无。
