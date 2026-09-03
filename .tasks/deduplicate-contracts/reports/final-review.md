APPROVED

# deduplicate-contracts 整树终审 R2

## 结论

首轮唯一 Important（I-1）已彻底解决：`apps/server` 现在显式声明其直接运行时依赖 `@einfach-agent/ai`，lock importer 同步，真实 server bundle 保留 external import，不再内联第二份 provider transport policy。新增 package boundary 测试在当前源码形态下覆盖合理，进程启动与临时路径处理可跨 Windows/POSIX 工作。

12 个原编号仍各自对应一个独立提交，历史未改写；原第 10 项仍未实施。follow-up 只补第 3 项的发布/打包边界及其回归测试，没有破坏其余 11 项或七域 primitives 的集成。

**没有 Critical 或 Important 发现。** 保留一个不阻断的基线 Minor，见下文。

## 审查口径

- 基线：`55a3d2e`
- 当前 HEAD：`67de8f5`
- 阅读了当前 `index.md`、首轮 `reports/final-review.md`、`reports/final-fix-review.md`、`git diff 55a3d2e` 全量变更，以及当前未提交 tracked diff 和未跟踪的 `apps/server/src/packageBoundary.test.ts`。
- 产品代码只读；本 reviewer 仅覆盖本报告，未提交、未暂存，也未修改 index/任务卡。
- 编排者已在当前工作树重跑：package boundary 5/5、`pnpm build` 通过、全量 `pnpm test` 为 784 files / 6375 tests passed，3 files / 3 tests skipped。本轮依要求未重跑。

## Findings

### Critical

无。

### Important

无。首轮 I-1 已关闭，证据见下一节。

### Minor

#### M-1 — 基线遗留的活动轮同名死导出仍存在

`packages/agent-core/src/runtime/commands/turnSafety.ts:6-11` 仍有旧的 `currentTurnStartIndex(items)`，与 canonical `runtime/activeTurnItems.ts:12-24` 同名但语义不同。生产消费方已经全部使用 canonical owner，该旧导出没有消费方，且文件自基线以来未改；因此不是本树或 follow-up 回归，不阻断批准。后续可独立删除或改名，避免误导入。

## 首轮 I-1 闭环

### 直接依赖与 lockfile：通过

- `apps/server/package.json:31-35` 已把 `@einfach-agent/ai: workspace:*` 加入运行时 `dependencies`，与 `modelRouteBody.ts:29` 的 value import 对齐。
- `pnpm-lock.yaml:161-175` 的 `apps/server` importer 同步记录 `specifier: workspace:*` 和 `version: link:../../packages/agent-ai`。
- `apps/server/tsup.config.ts:15-18` 的说明已更新为 ai/core/host-node 三个声明完整的 runtime packages；继续使用共享 `getProductionDeps` 自动 external，未再维护第二份手写 external 名单。

### 实际打包边界：通过

- 编排者完成 build 后的 `apps/server/dist/main.js:331` 保留 `from "@einfach-agent/ai"`；产物中不再出现内联源标记 `providerTransport.ts`，也没有本地 `PROVIDER_TRANSPORT_LIMITS` 定义。
- 因此 server 的 HTTP body limit 与 external 的 host route/body/origin policy 在运行时都解析到依赖提供的同一 package 版本，首轮指出的内联快照漂移已经消失。
- manifest、lock importer、源码 import 和 bundle 结果四层互相一致；monorepo 根解析不再掩盖缺失的直接依赖。

## package boundary 测试审查

`apps/server/src/packageBoundary.test.ts` 的范围与实现合理：

- 递归扫描当前 `apps/server/src` 的 production `.ts` 文件，并排除仓库现用的 `.test.ts`、`.testHarness.ts`、`.testFixtures.ts` 命名；当前目录不存在需要额外纳入的 `.tsx`/`.mts`/`.cts`/JS/`.d.ts` 生产文件。
- 通过 TypeScript AST 区分 runtime 与 type-only import/export，覆盖静态 import、re-export、裸 side-effect import 和字符串字面量 dynamic import；workspace subpath 归一到 package root。
- matcher 的表驱动测试覆盖 named、dynamic、bare import，并验证 `@einfach-agent/ai-extra` 不会被错认成目标包。
- 主断言同时要求扫描出的 workspace runtime packages 都在 server manifest 中，并从真实 `tsup.config.ts` 构建临时 bundle，逐项确认仍有 external import；这能复现并拦截首轮 I-1 的“缺声明后静默内联”。
- tsup CLI 通过 `createRequire(import.meta.url)` + `require.resolve('tsup/package.json')` 从测试自身的 Node 解析上下文定位，再用 `process.execPath` 直接运行 JS bin。它不依赖 `.cmd` shim、shell 或 PATH；`execFile` argv 对 Windows/POSIX 和含空格路径均安全。
- 每次测试用 `mkdtemp(tmpdir())` 获取唯一 outDir，并在 `finally` 只递归删除该明确目录；并发 worker 不共享产物，也不读写仓库已有 `apps/server/dist`。
- 测试文件 118 行，职责单一且低于 300 行门槛。

未来如果 server 新增 `.tsx`/`.mts` 等生产扩展名，或使用非字面量 runtime loader，应同步扩展扫描器；这不是当前文件集合的遗漏。

## 原提交与跳过项

`git rev-list --count 55a3d2e..HEAD` 仍为 12；按历史顺序为：

| 原编号 | commit | 范围 |
|---|---|---|
| 002 | `97a92e9` | CLI model config validation |
| 004 | `17113d9` | archive path safety |
| 006 | `7939d09` | active turn boundary |
| 001 | `4b911d1` | versioned archive result payload |
| 007 | `558de25` | plan persistence barrier |
| 003 | `d2104e3` | provider transport policy |
| 008 | `2d0fe21` | delegation capabilities |
| 009 | `f8605fe` | workspace mutation contracts |
| 012 | `c6182c5` | shell execution factory |
| 005 | `9316692` | history target/query contract |
| 011 | `82431a4` | recovery persistence facade |
| 013 | `67de8f5` | seven-domain protocol primitives |

- 每个原编号仍是一个独立、可回滚的实现提交；follow-up 当前未提交，没有 squash、amend 或改写这 12 个提交。
- 日志中没有第 10 项提交。`packages/agent-ai/src` 仍只改 provider adapter/message/route/origin/transport policy 文件，没有 provider file lifecycle/cache/registry 改动。
- follow-up 的产品面仅为 `apps/server/package.json`、`apps/server/tsup.config.ts`、`pnpm-lock.yaml` 和新增的 `packageBoundary.test.ts`；其余未提交变化是任务账本/审查报告。它是第 3 项缺失的发布边界闭环，没有跨入其他原编号。

## 跨项回归核对

完整 diff 中的已知修复点保持一致：

- archive payload 的 `version`、`changeSets`、started metadata 与 producer/replay 校验未变。
- CLI API key/base URL、archive path containment、legacy history cursor、turnId-aware current turn、plan persistence barrier 均未被 follow-up 触碰。
- delegation tuple/profile/dangerous subset、workspace decoder/hash、recovery facade、shell factory 的单一 owner 与兼容入口未变。
- 七域 primitives（server bounded body、observability IDB database owner、persistence IDB transaction、FS result envelope、host `pathExists`、`ToolResult` serializer、`ModelSettings` schema）均保持原接线。
- follow-up 只改变 Node server 的 package/build 元数据和 Node-only 测试，没有向浏览器共享模块引入 Node API，也没有改变公开 exports 或跨包类型 API。

首轮行数审计结论也未被改变：新增产品源码最大 234 行；本次新增测试 118 行。两个仅小改的存量超限测试仍为 376 行与 872 行，按既定规则记录但不阻断。

## 工作树说明

当前工作树按编排计划尚包含未提交 follow-up：3 个 tracked 产品文件、1 个未跟踪产品测试，以及 index/两份最终报告；没有其他产品变化。应由编排者在本批准后按既定 follow-up 范围提交，本 reviewer 不代为提交。

## 最终回执

**APPROVED** — 首轮 I-1 已在依赖声明、lock importer、真实 bundle 与跨平台回归测试四层闭环；12 个原提交与跳过第 10 项保持不变，未发现 follow-up 引入的集成回归。
