# 重复逻辑收敛

## 全局约束
- 原审查第 10 项（DeepSeek/Kimi provider 文件生命周期）明确不做。
- 原审查其余每个编号形成一个独立、可回滚的 Git commit；不得 squash 或改写既有历史。
- 每个文件只负责一个业务点或抽象；普通文件不超过 300 行，强内聚复杂实现不超过 500 行。
- 新共享代码必须有明确领域名，禁止新增 `utils`、`common`、`misc` 大杂烩。
- 只消除同层规则的多 owner；不同信任边界仍分别执行校验，不合并不同后端 adapter 生命周期。
- 每项须补足防漂移或行为回归测试；执行 agent 不 commit、不 stage，由编排者审查后按任务范围提交。
- 工作区可能同时存在其他任务的未提交改动；不得修改、暂存或还原任务 files 之外的文件。

## 任务树
- 000 重复逻辑收敛 (`group`)
  - 001 归档恢复保留完整子 Agent 结果 (`leaf`，依赖：无)
  - 002 CLI 与宿主执行同一模型凭据和端点安全规则 (`leaf`，依赖：无)
  - 003 三种运行表面消费同一 provider transport policy (`leaf`，依赖：002)
  - 004 所有归档 CLI 使用同一安全路径映射 (`leaf`，依赖：无)
  - 005 history target 与查询枚举只有一个契约 owner (`leaf`，依赖：003)
  - 006 所有恢复判据使用同一当前轮边界 (`leaf`，依赖：无)
  - 007 命令与模型工具共享同一计划持久化屏障 (`leaf`，依赖：006)
  - 008 delegate_agent schema、解析与文档由同一能力集合驱动 (`leaf`，依赖：001)
  - 009 workspace mutation 类型与 change context 只有一个 owner (`leaf`，依赖：无)
  - 011 history 通过 persistence facade 读取 recovery 数据 (`leaf`，依赖：005)
  - 012 三个平台 shell 工具共享同一执行内核 (`leaf`，依赖：无)
  - 013 剩余机械协议副本由各领域小模块接管 (`leaf`，依赖：001,003,005,006,007,008,009,011,012)

## 状态表
| id | 任务 | model | status | created | done |
|---|---|---|---|---|---|
| 001 | 归档恢复保留完整子 Agent 结果 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 002 | CLI 与宿主执行同一模型凭据和端点安全规则 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 003 | 三种运行表面消费同一 provider transport policy | gpt-5.6-sol | running | 2026-09-03 | |
| 004 | 所有归档 CLI 使用同一安全路径映射 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 005 | history target 与查询枚举只有一个契约 owner | gpt-5.6-sol | pending | 2026-09-03 | |
| 006 | 所有恢复判据使用同一当前轮边界 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 007 | 命令与模型工具共享同一计划持久化屏障 | gpt-5.6-terra | running | 2026-09-03 | |
| 008 | delegate_agent schema、解析与文档由同一能力集合驱动 | gpt-5.6-terra | pending | 2026-09-03 | |
| 009 | workspace mutation 类型与 change context 只有一个 owner | gpt-5.6-sol | pending | 2026-09-03 | |
| 011 | history 通过 persistence facade 读取 recovery 数据 | gpt-5.6-terra | pending | 2026-09-03 | |
| 012 | 三个平台 shell 工具共享同一执行内核 | gpt-5.6-terra | pending | 2026-09-03 | |
| 013 | 剩余机械协议副本由各领域小模块接管 | gpt-5.6-sol | pending | 2026-09-03 | |

## 遗留与发现
- 原审查第 10 项保留现状，不在本任务树中实施。
- 本次只处理审查报告列出的重复逻辑；其他存量超限文件不顺手重构。

## 决策与变更
- 裁决: 用户的“其它的做、每做一次 commit 一次”视为对整棵树的执行确认 — 请求已明确给出范围和提交粒度 — 若理解有误，代价是产生多个可独立回滚的本地提交。
- 裁决: 原第 13 项保持一个任务和一个 commit — 遵守用户按原编号提交的要求 — 代价是该提交会跨多个领域，但每个新增模块仍须单一职责。
- 裁决: 先并行 001、002、004，仅因为三者 files 不相交 — 缩短交付等待 — 代价是提交前工作区同时存在互不相干的未提交改动，故必须用路径级暂存。
- 2026-09-03：派发首批 001、002、004。
- 2026-09-03：002 执行与独立审查通过；编排者复跑 3 个定向文件、51 tests 通过。Minor：缺少 DeepSeek 快速路径与非法兼容端点的组合测试，不阻断。
- 2026-09-03：002 已提交为 `97a92e9`；依赖解锁，派发 003。
- 2026-09-03：004 首审发现 Unicode 归档 ID 兼容回归，进入 R1；修复后等待复审。
- 2026-09-03：004 R1 复审通过；编排者复跑 3 个文件、16 tests 通过，准予提交。
- 2026-09-03：004 已提交为 `17113d9`；派发无文件重叠的 006，base `17113d9`。
- 裁决: 003 纳入 `scripts/model-preview-relay-body.ts` 及测试 — 原目标明确要求 relay 消费共享 body/file-name 判据，这是实现既定验收而非扩 scope — 若不纳入，代价是保留已知 C1 分叉。
- 2026-09-03：001 首审 REJECTED：未知 payload version 被恢复为 done、started metadata 覆盖 snapshot、缺真实 producer→replay 测试；进入 R1。
- 裁决: 003 纳入 `packages/host-node/package.json` 与 `pnpm-lock.yaml` — host-node 已运行时消费 agent-ai，发布包必须显式声明 workspace 依赖 — 若不纳入，独立安装会缺模块。
- 2026-09-03：006 独立审查通过；编排者复跑 3 个文件、17 tests 通过。Minor：未消费的 `commands/turnSafety.ts` 另有同名不同语义函数，留到最终清理裁决。
- 2026-09-03：006 已提交为 `7939d09`；依赖解锁，派发 007。
- 2026-09-03：001 R1 复审通过；编排者复跑 7 个文件、30 tests 通过。指定 tsc 仅受范围外 md?raw 声明阻断，留待最终验证处理。
