---
id: "010"
title: 建立会话策略契约
kind: leaf
parent: "100"
depends_on: []
model: gpt-5.6-sol
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
done: 2026-09-08
files:
  - packages/agent-core/src/state/sessionCapabilityPolicy.ts
  - packages/agent-core/src/state/sessionCapabilityPolicy.test.ts
  - packages/agent-core/src/state/core.type.ts
  - packages/agent-core/src/state/recoverySnapshot.codec.ts
  - packages/agent-core/src/state/recoverySnapshot.type.ts
  - packages/agent-core/src/state/sessionMetaProjection.ts
  - packages/agent-core/src/runtime/sessionCapabilityCatalog.ts
  - packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts
  - packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts
  - packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts
  - packages/agent-core/src/runtime/commands/sessionCommands.ts
  - packages/agent-core/src/runtime/commands/runLifecycleCommands.ts
  - packages/agent-core/src/runtime/userInputPreparation.ts
  - packages/agent-core/src/runtime/commands.ts
  - packages/agent-core/src/index.ts
  - packages/agent-core/src/**/recovery*.test.ts
  - packages/agent-core/src/runtime/commands*.test.ts
  - .tasks/conversation-capabilities/reports/010-report.md
---

# 建立会话策略契约

## 目标

建立唯一、可持久化、可测试的会话能力策略，并提供 UI 与运行时共同消费的目录、草稿修改、复制与锁定 API。

## 必须实现的语义

- 新 `SessionMeta` 默认携带 v1 草稿策略。草稿只记录取消项；进入锁定态时解析当前工具/Skill 目录，
  应用插件信任、host 能力和工作区 Skill 偏好上界，然后写入排序、去重后的具体 allowlist 与 `lockedAt`。
- `loadedTools` 不得参与权限判断。把纯策略类型、normalize/toggle/lock/clone/allow 判断放在独立文件，
  供 020 直接复用，不能在 UI 和 runtime 各复制一套。
- 控制工具 `request_tool_schema`、`skill_search`、`skill_read` 不进入可配工具目录，且策略层把它们视为始终允许。
- 暴露稳定命令：读取指定/当前会话的可配置目录与状态；只在草稿态切换单项；从任意策略复制出新的
  草稿会话。命令返回可区分的结果或抛出明确领域错误，锁定态必须拒绝写入。
- 目录项至少包含稳定 name、显示 label/description、kind、是否当前可用、是否选中。锁定 allowlist 中已消失
  的 name 必须仍作为 unavailable 项返回，不能静默删除。
- `sendMessage` 在输入与附件准备成功后、调用 `runSession` 前锁定；对并发修改做版本/快照校验，防止
  prepare 期间用户切换后用旧目录锁定。空输入、准备失败、队列拒绝不锁；锁定持久化失败不得启动模型。
- recovery codec/type/projection、SQLite/IndexedDB 既有 blob 路径都能往返新字段。缺字段老会话保持
  `legacy-unrestricted` 只读语义，不能被当作新草稿；新建空白会话必须显式是 draft。
- 复制锁定策略时，目标是新草稿：当前仍可用且原来允许的项选中，原来不允许或已消失的项不选中；
  复制 legacy 会话则使用当前安全默认值。
- 不改变模型、thinking、审批模式的现有可编辑规则。

## 文件职责

- `sessionCapabilityPolicy.ts`：纯数据契约与纯变换。
- `sessionCapabilityCatalog.ts`：从 registries、host、workspace 偏好解析当前安全目录。
- `sessionCapabilityCommands.ts`：会话级读取、草稿修改、复制命令。
- 既有 state/command 文件只做字段接线与生命周期调用；若改动使文件超过硬上限，按职责拆新文件并在报告列出。

## 验收标准

1. 纯策略测试覆盖默认草稿、toggle、去重排序、控制工具、锁定不可变、丢失项与 clone。
2. 命令测试覆盖目录加载、锁定写入拒绝、复制为草稿、legacy 兼容与全局/工作区上界。
3. 生命周期测试证明有效首发锁定发生在 run 前，准备失败/空输入不锁，持久化失败不运行，重复发送不改 allowlist。
4. recovery round-trip 与严格 key 校验包含新字段，旧 snapshot 仍可恢复。
5. 运行本任务相关 Vitest、`pnpm exec tsc -b --pretty false`、`git diff --check` 与声明文件 `wc -l` 全绿。
6. 报告写入 `reports/010-report.md`，列出精确文件、测试命令、结果、已知风险；不得 commit。

## 执行记录（仅编排者回写）

- 2026-09-08：任务树创建，待派发。
- 2026-09-08：已派发执行。
- 2026-09-08：执行与独立审查 APPROVED；编排者复跑核心 5 文件 57 项、TypeScript 与 diff-check 全绿。
