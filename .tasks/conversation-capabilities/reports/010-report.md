# 010 执行报告：建立会话策略契约

## 结果

已完成。新会话显式创建 v1 draft 策略；旧会话缺字段时保持只读的
`legacy-unrestricted`。首条有效消息在附件准备成功后、模型启动前，把当前安全目录解析成稳定的
工具与 Skill allowlist，并以 recovery writer 作为强持久化边界。锁定失败不会启动模型。

`one-file-one-thing` 细则影响了模块划分：纯策略、环境目录和会话命令分别独立成文件；所有新增、
修改的普通源文件与测试文件均不超过 300 行。

## 变更文件

- `packages/agent-core/src/state/sessionCapabilityPolicy.ts`：v1 draft/locked 数据契约，以及纯
  normalize、toggle、lock、clone、allow、版本快照函数；协议控制工具恒允许。
- `packages/agent-core/src/state/sessionCapabilityPolicy.test.ts`：纯策略默认值、切换、排序去重、
  控制工具、锁定不可变、clone 与严格形状测试。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts`：从 tool registry、host bridge、内置
  Skills、项目 Skills 与工作区禁用偏好解析安全目录，并保留锁定 allowlist 的 unavailable 项。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts`：目录上界、控制工具过滤、稳定排序、
  host 能力与 unavailable tombstone 测试。
- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts`：指定/当前会话目录读取、draft
  toggle、durable lock、clone 命令与稳定领域错误。
- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts`：命令读写、legacy、clone、
  recovery/session 持久化失败、prepare 竞态、空输入、准备失败、run 阻塞与重复发送测试。
- `packages/agent-core/src/state/core.type.ts`：`SessionMeta.capabilityPolicy` 可选持久字段；缺字段保留
  legacy 语义。
- `packages/agent-core/src/state/recoverySnapshot.type.ts`：recovery 静态会话投影包含策略字段。
- `packages/agent-core/src/state/recoverySnapshot.codec.ts`：策略字段的严格 v1 key/shape 校验。
- `packages/agent-core/src/state/sessionMetaProjection.ts`：静态 SessionMeta 投影往返策略字段。
- `packages/agent-core/src/state/recoverySnapshot.type.test.ts`：新策略 round-trip、旧快照兼容及损坏策略
  拒绝测试。
- `packages/agent-core/src/state/recoveryProjection.session.test.ts`：恢复投影保留锁定策略测试数据。
- `packages/agent-core/src/runtime/commands/sessionCommands.ts`：新会话默认显式 draft，并允许 clone 注入
  已计算的新 draft。
- `packages/agent-core/src/runtime/commands/runLifecycleCommands.ts`：prepare 前捕获策略版本，prepare 后
  校验并在 `runSession` 前等待锁定持久化。
- `packages/agent-core/src/runtime/userInputPreparation.ts`：增加可区分的
  `capabilities_changed` 发送拒绝原因（编排者已知并同意补入任务声明）。
- `packages/agent-core/src/runtime/commands.ts`：装配与导出会话能力命令。
- `packages/agent-core/src/index.ts`：公开 UI/runtime 共用的命令、目录与纯策略契约。
- `packages/agent-core/src/runtime/recoveryToolSafety.integration.test.ts`：按新的更早 durability barrier
  更新失败断言：首发直接拒绝、无 run、无模型或工具副作用。
- `.tasks/conversation-capabilities/reports/010-report.md`：本报告。

## 验证命令与结果

1. `pnpm exec vitest run packages/agent-core/src/state/sessionCapabilityPolicy.test.ts packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts packages/agent-core/src/state/recovery*.test.ts packages/agent-core/src/state/persistence/recovery*.test.ts packages/agent-core/src/runtime/*recovery*.test.ts packages/agent-core/src/runtime/commands*.test.ts packages/agent-core/src/runtime/commands/*.test.ts && pnpm exec tsc -b --pretty false && git diff --check`
   - 38 个测试文件通过，272 个测试通过。
   - TypeScript project references 检查通过。
   - `git diff --check` 通过。
2. `pnpm exec vitest run packages/agent-core/src/state/persistence/*.test.ts packages/agent-core/src/state/recoveryProjection*.test.ts packages/persistence-idb/src/sessionsPersistence.test.ts packages/persistence-sqlite/src/sqliteDriver.test.ts`
   - 12 个测试文件通过，90 个测试通过。
   - 覆盖 hydrate/recovery 投影及 IndexedDB、SQLite 会话 blob 往返路径。
3. `wc -l` 对上述 18 个变更的源文件/测试文件逐项检查。
   - 最大为 `packages/agent-core/src/index.ts` 300 行；其余均低于 300 行。

## 已知风险

- 强锁定优先通过既有 recovery writer 持久化；生产 SQLite/IndexedDB 装配均提供 recovery driver，
  hydrate 时 recovery 的静态 SessionMeta 投影是权威值。仅配置 sessions driver 的精简宿主走直接
  `saveSessions` 并等待成功；该兼容分支有失败测试，但没有另建持久化队列。
- 本任务只建立策略契约与锁定生命周期。manifest、schema、实际工具/Skill 执行和子代理的 allowlist
  强制消费由依赖本任务的 020 负责；当前策略函数已作为唯一公共判据导出。
- 未运行全仓门；按编排要求留给最终审计。未 commit，未恢复 stash。
