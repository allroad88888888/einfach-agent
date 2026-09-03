# 019 两条 server JSON 路由共享独立 Content-Type 判据

状态：`DONE`

## 改动摘要

- 新增 `apps/server/src/jsonContentType.ts`，作为 `hasJsonContentType` 的唯一实现 owner；它只判断请求是否声明 `application/json`，支持大小写不敏感的 media type 与参数。
- 将原有 Content-Type 正反例迁移至 `jsonContentType.test.ts`。
- `invokeRoute.ts` 与 `modelRoute.ts` 直接导入新模块。
- `invokeRouteBody.ts` 仅保留 invoke body 投影；`modelRouteBody.ts` 不再跨业务 re-export Content-Type 判据。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run apps/server/src/jsonContentType.test.ts apps/server/src/invokeRouteBody.test.ts apps/server/src/invokeRoute.test.ts apps/server/src/modelRoute.test.ts` | 通过：4 个测试文件、43 个测试。 |
| `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` | 通过。 |
| `git diff --check` | 通过：无空白错误。 |
| `wc -l`（本次新增/修改源码和测试） | 通过：最大 150 行，均低于 300 行。 |

## 静态核对

- `hasJsonContentType` 只在 `jsonContentType.ts` 定义。
- 两个路由均直接从 `jsonContentType.ts` 导入该判据。
- `modelRouteBody.ts` 与 `invokeRouteBody.ts` 均不再导出该判据。

## 范围外发现

- 工作区同时存在 018、020 等并行任务的未提交改动；未修改、暂存或还原它们。

## 疑虑

- 无。

## 建议后续动作

- 由编排者按本任务 files 范围复核并创建独立提交。
