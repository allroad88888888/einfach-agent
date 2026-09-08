# 010 独立审查

## 结论

**APPROVED**

未发现阻断 010 合入的问题。声明的产品/测试改动均在任务范围内；draft/locked/legacy、控制工具、
旧 recovery snapshot、目录安全上界与 unavailable、clone、prepare revision 竞态和 durability barrier
均有实现与定向测试证据。全部 18 个声明源文件/测试文件不超过 300 行。

## 逐项审查

### 1. draft / locked / legacy 判别

- `packages/agent-core/src/state/sessionCapabilityPolicy.ts:5-24` 用判别联合明确区分 v1 `draft` 与
  `locked`；draft 仅保存 disabled 集合，locked 保存具体 allowlist 与 `lockedAt`。
- `packages/agent-core/src/state/sessionCapabilityPolicy.ts:75-95` 对版本、state、revision、严格 key、
  排序去重数组及 `lockedAt` 做 canonical shape 校验。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:108-114` 只在策略字段缺失时返回
  `legacy-unrestricted`；`packages/agent-core/src/state/core.type.ts:196-200` 明确缺字段是旧版只读语义。
- `packages/agent-core/src/runtime/commands/sessionCommands.ts:68-76` 保证正常新建会话显式携带 draft；
  `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:122-127` 同时拒绝 legacy 与 locked
  的修改。
- 测试证据：`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:48-84` 覆盖新
  draft、locked 拒写、legacy unrestricted/read-only 及 legacy clone。

### 2. 控制工具规则

- `packages/agent-core/src/state/sessionCapabilityPolicy.ts:33-37` 唯一定义三个协议控制工具：
  `request_tool_schema`、`skill_search`、`skill_read`。
- `packages/agent-core/src/state/sessionCapabilityPolicy.ts:151-161` 在普通 policy 判断之前恒允许这三个
  tool；判断完全不读取 `loadedTools`。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:80-82` 将控制工具排除在可配置工具目录外。
- 测试证据：`packages/agent-core/src/state/sessionCapabilityPolicy.test.ts:84-91` 覆盖 locked 空 allowlist
  下控制工具仍允许；`packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts:42-47,81-93`
  注册控制工具后验证目录只保留普通可用工具。

### 3. 旧 snapshot 兼容与持久化投影

- `packages/agent-core/src/state/recoverySnapshot.type.ts:31-43` 将策略纳入静态 recovery session 投影；
  `packages/agent-core/src/state/sessionMetaProjection.ts:10-22` 在 SQLite/IndexedDB 共用的静态投影中保留
  字段，同时对缺字段不做补写。
- `packages/agent-core/src/state/recoverySnapshot.codec.ts:19,81-89` 把策略设为 optional，故旧 snapshot
  继续可读；字段存在时调用严格策略 codec，损坏/未来形状 fail closed。
- 测试证据：`packages/agent-core/src/state/recoverySnapshot.type.test.ts:141-164` 覆盖新字段 JSON 往返、
  缺字段旧 snapshot 和损坏/未知 key 拒绝；
  `packages/agent-core/src/state/recoveryProjection.session.test.ts:7-33,46-63` 证明 recovery capture 保留
  locked policy。
- 持久化驱动定向集通过 12 个文件、90 个测试，覆盖 agent-core persistence、recovery projection、
  IndexedDB sessions 与 SQLite driver。

### 4. 目录上界、stable name 与 unavailable

- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:80-95` 先应用 host tool 可见性，并通过
  workspace root、项目 Skill 扫描结果和 workspace disabled preference 得到当前安全目录。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:96-103` 直接使用 registry/project entry 的
  canonical `name` 作为持久键；没有使用显示 label、数组位置或临时 id。registry（含内置/用户
  Skills）优先，项目 Skill 仅在同名键不存在时加入，结果再稳定排序。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts:18-47` 的 registry 名和
  `project/release` 项目名验证两类 name 进入同一稳定命名面；`:81-93` 验证 host/workspace 上界，
  `:117-124` 验证 server tool 仅在 host bridge 可用时出现。
- `packages/agent-core/src/runtime/sessionCapabilityCatalog.ts:49-66,104-107` 对 locked allowlist 中当前
  已消失/被上界移除的名字补 selected + unavailable tombstone，不静默删除；测试位于
  `packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts:95-115`。

### 5. clone 语义

- `packages/agent-core/src/state/sessionCapabilityPolicy.ts:136-149` 将 unavailable 或未选中的当前项写入
  新 draft disabled 集合；legacy 则回到当前安全默认 draft。
- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:181-202` 在读取目录后再校验 source
  policy version，并创建新的 draft session，不修改源会话。
- `packages/agent-core/src/state/sessionCapabilityPolicy.test.ts:93-112` 覆盖 disappeared allowed 项在 clone
  中被禁用；`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:66-102` 覆盖
  legacy clone 与 locked clone，证明原拒绝项和已消失项不会被重启用。

### 6. 首发 prepare revision 竞态

- `packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:52-65` 在 prepare 前捕获完整 canonical
  policy version；`:66-98` 只在 prepared content 有效、会话仍存在、settings/run 状态通过后 await
  lock，并把 version 不一致映射为 `capabilities_changed`。
- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:145-177` 解析当前目录后再次读取策略，
  对 expected version 与 catalog version 做双重校验；draft toggle 每次递增 revision，见
  `packages/agent-core/src/state/sessionCapabilityPolicy.ts:102-115`。
- 测试证据：`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:123-146` 覆盖空输入、
  prepare 失败不锁，以及 prepare 期间 toggle 后拒绝旧快照且不启动模型。

### 7. durability failure 不 run

- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:68-101` 优先等待 recovery writer 的
  `saved`；stale/tombstoned/error、已配置但不可用 recovery，以及 sessions-only driver rejection 都按
  `persistence_failed` 失败关闭。
- `packages/agent-core/src/runtime/commands/sessionCapabilityCommands.ts:164-177` 先暂置 locked，再等待持久化；
  失败时仅在当前仍是该版本的情况下回滚，避免覆盖并发新状态。
- `packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:91-104` 只有 lock promise 成功后才执行
  rename 与 `withRun(...runSession...)`，所以 durability failure 不可能越过 model start 边界。
- 测试证据：`packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts:104-121`
  证明 run 观察到的 policy 已 durable；`:148-181` 覆盖 recovery 与 sessions-only 失败回滚且 run=0；
  `packages/agent-core/src/runtime/recoveryToolSafety.integration.test.ts:218-228` 进一步覆盖 error/stale/
  tombstoned 三类 durability failure 均无 run/model request。

### 8. 文件边界与行数

- 新模块职责清晰：纯策略变换见 `sessionCapabilityPolicy.ts:1-162`；安全目录投影见
  `sessionCapabilityCatalog.ts:1-115`；命令与 durable lock 编排见
  `sessionCapabilityCommands.ts:1-211`。未出现 `utils`、part 文件或按行数假拆分。
- `wc -l` 检查 18 个声明源文件/测试文件：最大为 `packages/agent-core/src/index.ts` 300 行，第二大为
  `recoverySnapshot.codec.ts` 281 行；其余均低于 300。
- `index.ts` 是包对外边界 barrel，符合 barrel 例外且仍是单一职责；010 导出集中在
  `packages/agent-core/src/index.ts:115-123`。但它已恰好到硬上限，后续新增导出必须先重构公开面或拆分，
  不能再靠压缩排版增长。此为非阻断维护风险。

## 声明范围对账

- `git status --short --untracked-files=all` 显示 010 的 6 个新增源/测试文件与 12 个修改源/测试文件；
  全部落在 `010-session-policy-contract.md` 的 `files` 声明内。
- `userInputPreparation.ts` 已在任务声明中，实际仅增加可区分的 `capabilities_changed` rejection reason，
  见 `packages/agent-core/src/runtime/userInputPreparation.ts:45-64`。
- 未发现 010 执行者修改声明外产品/测试文件。

## 命令结果

1. `pnpm exec vitest run packages/agent-core/src/state/sessionCapabilityPolicy.test.ts packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts packages/agent-core/src/runtime/commands/sessionCapabilityCommands.test.ts packages/agent-core/src/state/recovery*.test.ts packages/agent-core/src/state/persistence/recovery*.test.ts packages/agent-core/src/runtime/*recovery*.test.ts packages/agent-core/src/runtime/commands*.test.ts packages/agent-core/src/runtime/commands/*.test.ts`
   - PASS：38 test files，272 tests。
2. `pnpm exec vitest run packages/agent-core/src/state/persistence/*.test.ts packages/agent-core/src/state/recoveryProjection*.test.ts packages/persistence-idb/src/sessionsPersistence.test.ts packages/persistence-sqlite/src/sqliteDriver.test.ts`
   - PASS：12 test files，90 tests。
3. `pnpm exec tsc -b --pretty false`
   - PASS，exit 0。
4. `git diff --check`
   - PASS，exit 0，无输出。
5. 对 18 个声明源文件/测试文件执行 `wc -l`
   - PASS：全部 `<= 300`，最大 300。

## 非阻断风险

- 当前 user/project Skill stable name 依赖 registry 与 project scanner 已提供 canonical、跨重启稳定的
  `name`；010 不再派生第二套 id。若未来允许不同 scope 产生完全相同的 canonical name，当前 Map 的
  registry-first 去重会只展示一个条目，因此新增 scope 设计时应继续保证命名空间唯一，或同步升级策略 key。
- `index.ts` 已无任何行数余量；后续任务不得继续在该文件追加导出而不先处理边界。
