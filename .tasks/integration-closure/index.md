# 五棵 Issue 树集成收口

创建：2026-08-31

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：已完成

## 目标边界

修复五棵功能树合并到同一工作区后暴露的旧测试契约漂移，并用一次全仓终审取代各树互不相见的局部绿灯。

本树不改变已经终审的产品语义：DeepSeek 静态图片门禁、Lingui 真实 Provider、逐模型 Thinking
能力、连接 profile probe 与 Tauri server-runtime 架构均保持。010、020 只修旧测试夹具；产品语义发现
不一致时必须 `BLOCKED`，不得为了绿灯放宽生产边界。

## 全局约束

- 编排者只写 `.tasks/`、审查、调度与提交；产品/测试代码由执行 agent 修改。
- 工作区混有五棵树与用户既有在途改动；禁止 reset、checkout、覆盖、批量格式化或暂存任务范围外文件。
- 普通文件不超过 300 行；测试同样受限。存量超限文件只允许任务内最小改动并在报告说明。
- 执行 agent 不得派子 agent、不得 commit；只写声明文件与对应报告。独立 reviewer 只写对应 review。
- 用户已于 2026-08-31 授权分批 commit。只有独立审查与编排者验收均通过的精确文件范围可以提交。
- 禁止真实付费模型、发布、push、上传 artifact 或读取真实 secret。

## 任务树

- 100 旧测试契约 (`group`)
  - [010](010-web-regression-fixtures.md) 同步 Web 回归夹具 (`leaf`，依赖：无)
  - [020](020-model-regression-fixtures.md) 同步模型回归夹具 (`leaf`，依赖：无)
- 200 总收口 (`group`)
  - [030](030-whole-tree-audit.md) 审核五棵树集成交付 (`leaf`，依赖：010、020、Tauri 065)
  - [035](035-stabilize-lingui-catalogs.md) 审阅并稳定 Lingui catalogs (`leaf`，发现自：030)
  - [040](040-split-tool-context-types.md) 按职责拆分工具上下文类型 (`leaf`，发现自：030)
  - [050](050-final-delivery-audit.md) 复核稳定后的五树交付 (`leaf`，依赖：035、040，发现自：030)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 同步 Web 回归夹具 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 020 | 同步模型回归夹具 | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 030 | 审核五棵树集成交付 | gpt-5.6-sol | blocked | 2026-08-31 | |
| 035 | 审阅并稳定 Lingui catalogs | gpt-5.6-terra | done | 2026-08-31 | 2026-08-31 |
| 040 | 按职责拆分工具上下文类型 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |
| 050 | 复核稳定后的五树交付 | gpt-5.6-sol | done | 2026-08-31 | 2026-08-31 |

## 验收总门

1. `pnpm test` 不再有旧夹具、错误 runner discovery 或跨树协议红项。
2. `pnpm build`、`pnpm check:state`、`pnpm check:boundaries`、`git diff --check` 全部通过。
3. Lingui extract/compile 后 English Missing 0，真实中英文全界面测试通过。
4. `node scripts/check-desktop-wrapper.mjs` 与 `pnpm desktop:build` 通过，Tauri 060 的发布矩阵有静态证据。
5. 新增/大改普通文件不超过 300 行；所有任务报告、review 与 index 状态一致。

## 决策与变更

- 裁决: 把同型旧测试漂移合批到独立收口树 — 它们分别消费已终审契约，不应重新打开产品设计；错了的
  代价是跨功能归属需在报告中逐项回链，但可避免四个不足十分钟的小叶。
- 裁决: Lingui 120/150 的历史“未审查”由 030 全树终审取代 — 产品 diff 已混入后续树，补写历史时点
  的伪审查不可信；错了的代价是不能得到两份逐叶历史 review，但最终范围证据更完整。
- 2026-08-31：用户要求继续推进并授权分批 commit，跳过新增收口树确认点。
- 2026-08-31：首批并行派发 010、020 与 Tauri 052；三叶文件面不相交。
- 2026-08-31：010 执行、独立审查与编排者 13/13 复跑通过；等待按依赖顺序批量提交。
- 2026-08-31：020 执行、独立审查与编排者 21/21 复跑通过；产品契约未改，等待批量提交。
- 2026-08-31：030 全机械门通过，但首次 clean extract 改写 catalog，不能标绿；发现 035 稳定生成产物。
- 2026-08-31：`tools/types.ts` 基线 309 行、本次新增 43 行至 352；按硬规则登记 040 职责拆分，不作为存量小改豁免。
- 2026-08-31：035/040 执行、独立审查与编排者复跑通过；catalog 已稳定，工具总契约降至 299 行，050 解锁。
- 2026-08-31：050 全量验收 DONE、最终独立审查 APPROVED；进入白名单分批提交，明确排除用户既有改动与未声明生成物。
