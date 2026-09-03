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
  - 014 行为与兼容性复审不发现阻断回归 (`leaf`，依赖：001–009,011–013)
  - 015 包边界与运行时集成复审不发现阻断缺口 (`leaf`，依赖：001–009,011–013)
  - 016 文件职责与测试证据复审不发现阻断债务 (`leaf`，依赖：001–009,011–013)
  - 017 当前轮边界只保留一个可导入实现 (`leaf`，依赖：016)
  - 018 子 Agent 能力值贯穿输入、恢复与归档协议 (`leaf`，依赖：016)
  - 019 两条 server JSON 路由共享独立 Content-Type 判据 (`leaf`，依赖：016)
  - 020 workspace 读写使用同一 content hash 原语 (`leaf`，依赖：016)

## 状态表
| id | 任务 | model | status | created | done |
|---|---|---|---|---|---|
| 001 | 归档恢复保留完整子 Agent 结果 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 002 | CLI 与宿主执行同一模型凭据和端点安全规则 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 003 | 三种运行表面消费同一 provider transport policy | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 004 | 所有归档 CLI 使用同一安全路径映射 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 005 | history target 与查询枚举只有一个契约 owner | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 006 | 所有恢复判据使用同一当前轮边界 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 007 | 命令与模型工具共享同一计划持久化屏障 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 008 | delegate_agent schema、解析与文档由同一能力集合驱动 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 009 | workspace mutation 类型与 change context 只有一个 owner | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 011 | history 通过 persistence facade 读取 recovery 数据 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 012 | 三个平台 shell 工具共享同一执行内核 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 013 | 剩余机械协议副本由各领域小模块接管 | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 014 | 行为与兼容性复审不发现阻断回归 | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 015 | 包边界与运行时集成复审不发现阻断缺口 | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 016 | 文件职责与测试证据复审不发现阻断债务 | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 017 | 当前轮边界只保留一个可导入实现 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 018 | 子 Agent 能力值贯穿输入、恢复与归档协议 | gpt-5.6-sol | done | 2026-09-03 | 2026-09-03 |
| 019 | 两条 server JSON 路由共享独立 Content-Type 判据 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |
| 020 | workspace 读写使用同一 content hash 原语 | gpt-5.6-terra | done | 2026-09-03 | 2026-09-03 |

## 遗留与发现
- 原审查第 10 项保留现状，不在本任务树中实施。
- 本次只处理审查报告列出的重复逻辑；其他存量超限文件不顺手重构。
- 多 agent 复审 Important（017 已关闭）：删除 stale current-turn helper，只保留 canonical owner。
- 多 agent 复审 Important（018 已关闭）：subagent 能力值由公共 owner 贯穿输入、恢复与归档协议。
- 多 agent 复审 Important（019 已关闭）：server JSON Content-Type 判据独立为单一 owner，两条路由直接消费。
- 多 agent 复审 Important（020 已关闭）：workspace read 与 mutation 共用同一 content hash 原语。
- 多 agent 复审 Minor（未处理）：`confirmedTools` 与 archive payload 的公开 TypeScript 输入收窄可能影响外部源码兼容；归档 producer 与 CLI 对 `.`/`..` 非常规 ID 映射不同；model body wrapper 缺直接映射测试；server 包边界测试不识别 CommonJS `require`；`write/guard.test.ts` 的固定向量位置注释与 020 implementation report 的一条 concern 已陈旧。
- 行数遗留不变：`runtime/modelTurn.test.ts` 872 行、`subagents/runtime.budgetAndConcurrency.test.ts` 376 行，均为存量超限测试的小改，本轮复审不擅自拆。

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
- 2026-09-03：001 已提交为 `4b911d1`；依赖解锁，派发 008。
- 裁决: 003 纳入 `packages/host-node/src/model/providerRoute.ts` — 它是 catalog route entry 的直接消费方，必须随共享类型接线 — 若不纳入，任务 files 与必要产品 diff 不一致。
- 2026-09-03：007 首审 REJECTED：checkpoint rollback 重建 adapter，导致 `PlanRuntimeFactory` 多调用一次；进入 R1。
- 2026-09-03：003 首审 REJECTED：共享 policy 新增了第二份官方 origin 硬编码；进入 R1，由 agent-ai 无环叶模块统一 owner。
- 2026-09-03：008 首审 REJECTED：tool profile/confirmedTools 未真正类型派生，危险全集错误依赖可委派子集，guide 对 workspace_verify 不完整；进入 R1。
- 2026-09-03：003 R1 复审通过；编排者复跑 8 个文件、95 tests 通过；修正任务卡 Web tsconfig 路径，准予提交。
- 2026-09-03：003 已提交为 `d2104e3`；依赖解锁，派发 005。
- 2026-09-03：008 R1 复审仍有旧注释反向绑定 root dangerous 与 child 授权；进入 R2，并补齐三份必要契约测试的 files 记录。
- 2026-09-03：008 R2 复审通过；编排者复跑 7 个文件、96 tests 通过，准予提交。
- 2026-09-03：008 已提交为 `2d0fe21`；派发无文件重叠的 012。
- 2026-09-03：009 独立审查通过；编排者复跑 8 个文件、79 tests 通过，准予提交。
- 2026-09-03：012 独立审查通过；编排者复跑 8 个文件、83 tests 通过，准予提交。
- 2026-09-03：005 首审 REJECTED：legacy v1 cursor 的 filters JSON 比较对 target 属性顺序敏感；进入 R1。
- 2026-09-03：005 R1 复审通过；编排者复跑 40 个文件、215 tests 通过，准予提交。
- 2026-09-03：005 已提交为 `9316692`；依赖解锁，派发 011。
- 裁决: 011 纳入 `pnpm-lock.yaml` — host-node 新增正式 workspace 依赖，冻结安装必须保持一致 — 若不纳入，CI/install 会在提交后失败。
- 2026-09-03：011 首审 REJECTED：row codec 对 session_id 自比较且在校验 key 前过滤 tombstone，损坏行从 fail-loud 退化为静默隐藏；进入 R1。
- 2026-09-03：011 R1 复审通过；编排者复跑 3 个文件、14 tests 通过，准予提交。
- 2026-09-03：011 已提交为 `82431a4`；全部前置依赖完成，派发最终编号 013。
- 裁决: 013 纳入 `packages/agent-core/src/runtime/modelTurn.test.ts` — 全量测试的旧单页假设已被当前 36 项 registry 确定性打破，改为验证分页完整集合是恢复验收门禁所需 — 代价是 013 含一处与去重无直接关系的小型测试维护；该存量测试文件 872 行只指出、不顺手重构。
- 2026-09-03：007 R1 复审通过；编排者复跑 3 个文件、19 tests 通过，准予提交。
- 2026-09-03：007 已提交为 `558de25`；派发无文件重叠的 009。
- 2026-09-03：013 独立审查通过；执行侧最终 `pnpm build`、`pnpm test` 全绿，编排者复跑 19 个关键文件、164 tests 通过，准予提交。
- 2026-09-03：009、012、013 分别提交为 `f8605fe`、`c6182c5`、`67de8f5`；原编号 001–009、011–013 共 12 个实现提交完成，第 10 项保持未做。
- 2026-09-03：整树首轮终审发现 `apps/server` 未声明直接运行时依赖 `@einfach-agent/ai`，共享 provider policy 会被静默内联；作为 003 的发布边界 follow-up 集中修复。
- 2026-09-03：follow-up R1 独立复审通过：server manifest/lock importer 已同步，真实 tsup 边界测试确认 workspace 运行时依赖 externalize；Windows `.cmd` 启动问题改为当前 Node 直接执行 tsup JS CLI，无剩余阻断项。
- 2026-09-03：编排者最终复跑新增边界测试 5/5、`pnpm build`、`pnpm test`；全量结果为 784 files / 6375 tests passed，3 files / 3 tests skipped。
- 2026-09-03：整树终审 R2 APPROVED；12 个原编号提交与跳过第 10 项保持不变，provider policy 发布边界 follow-up 无 Critical/Important 遗留。
- 裁决: 用户要求“另外多个 agent”复审，新增 014–016 三个只读复审叶并直接并行派发 — 三个风险视角可独立否决且不会产生产品文件冲突 — 代价是同一全量 diff 会被重复阅读。
- 2026-09-03：014 行为/兼容性 APPROVED，无 Critical/Important，记录 3 个 Minor；独立定向验证合计 60 files / 499 tests 通过。
- 2026-09-03：015 包边界/运行时集成 APPROVED，无发现；`check:dist`、packed-server 仓库外安装、临时 Web/Node 构建及 72 个定向测试通过。
- 2026-09-03：016 文件职责/测试证据 REJECTED，发现 4 个 Important 与 2 个 Minor；编排者逐项回读源码确认事实成立，作为待处理发现记账，不在只读复审请求中擅自修复。
- 裁决: 用户回复“开工”视为授权修复 016 的 4 个 Important，Minor 继续记账不动 — 对话直接承接上一轮四项阻断清单 — 若理解有误，代价是新增 4 个可独立回滚的本地提交。
- 裁决: 017–020 每项各一个 commit — 延续用户要求的提交粒度且四项可独立回滚 — 代价是共享审查账本会随各任务分次提交。
- 2026-09-03：018、019、020 files 不相交，先并行派发；017 等任一槽位释放即派发。
- 2026-09-03：019 执行完成，释放槽位后立即派发 017；019 进入独立审查门。
- 裁决: 018 增补 `subagents/runtimeState.ts`、`childAgentLoop.ts` — 二者是 confirmedTools 从规范化输入流向 archive producer 的必要类型通道 — 若不接线，公共类型收窄会在根 build 产生 TS2322。
- 裁决: 018 再增补 `subagents/delegationPolicy.ts`、`delegationBatch.ts` — policy 输出与 state 写入是同一 confirmedTools 类型链的上游 — 若不接线，根 build 产生 TS2345。
- 裁决: 020 的静态验收改为统计 `contentSha256` 定义，而非统计所有 SHA-256 调用 — workspace 另有格式和用途不同的 journal/path/run-index 指纹，属于不同协议 — 若强行共用会跨越抽象边界。
- 2026-09-03：019 实现与独立审查 APPROVED；编排者复跑 4 files / 43 tests 通过，准予独立提交。
- 2026-09-03：017 实现与独立审查 APPROVED；唯一 current-turn owner 与副作用测试证据成立，待编排者复验提交。
- 2026-09-03：020 实现与独立审查 APPROVED；编排者复跑 6 files / 79 tests，确认 `contentSha256` 只有一个定义，准予独立提交。两处陈旧说明记为 Minor，不进修复循环。
- 2026-09-03：019、017、020 已分别提交为 `1974e1f`、`23f5924`、`aea7d7d`，提交范围相互独立。
- 2026-09-03：018 实现与独立审查 APPROVED；编排者复跑 5 files / 82 tests，公共能力值已贯穿 input→policy→state→child→continuation/archive，准予独立提交。
- 2026-09-03：018 已提交为 `bfb7e85`；017–020 四项均保持一个独立产品提交。
- 2026-09-03：编排者在四项提交后的 HEAD 运行 `pnpm build` 与 `pnpm test`；build 通过，全量 787 files / 6419 tests passed，3 files / 3 tests skipped，进入整树终审。
- 2026-09-03：017–020 整树独立终审 APPROVED；四个 Important 全部关闭，无 Critical/Important，也未发现行为、legacy、fail-closed、依赖图、提交隔离或文件职责回归。
