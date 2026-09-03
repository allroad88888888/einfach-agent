---
id: 019
title: 两条 server JSON 路由共享独立 Content-Type 判据
kind: leaf
parent: 000
depends_on: [016]
discovered_from: 016
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: c804cd4
files:
  - apps/server/src/jsonContentType.ts
  - apps/server/src/jsonContentType.test.ts
  - apps/server/src/invokeRouteBody.ts
  - apps/server/src/invokeRouteBody.test.ts
  - apps/server/src/invokeRoute.ts
  - apps/server/src/modelRouteBody.ts
  - apps/server/src/modelRoute.ts
---

# 两条 server JSON 路由共享独立 Content-Type 判据

## 目标
把表单 CSRF 所需的 JSON Content-Type 判据放入独立领域模块，使 invoke/model route 直接消费它，`invokeRouteBody.ts` 只负责 invoke body 投影。

## 交付边界
Content-Type 安全判据及其测试必须一起迁移；两个 route 的 body 解析结果与 HTTP 行为不得改变。禁止通过跨业务 re-export 维持第二 owner 或隐蔽耦合。

## 上下文
`invokeRouteBody.ts` 当前文件头明确列出两个独立职责，`modelRouteBody.ts` 又从它 re-export `hasJsonContentType`。新模块建议名 `jsonContentType.ts`，一句话职责是判断请求是否声明 JSON media type。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- 现有 `hasJsonContentType(request: IncomingMessage): boolean` 行为：大小写不敏感，只接受 `application/json`，允许参数。
### 产出
- `jsonContentType.ts` 唯一导出并实现 `hasJsonContentType`；invoke/model route 直接 import。

## 验收标准
1. `invokeRouteBody.ts` 只保留 invoke body 投影；`modelRouteBody.ts` 不再跨业务 re-export Content-Type 判据。
2. Content-Type 现有正反例迁移到独立测试；invoke/model route 原有测试全部通过，HTTP 状态和错误语义不变。
3. `pnpm exec vitest run apps/server/src/jsonContentType.test.ts apps/server/src/invokeRouteBody.test.ts apps/server/src/invokeRoute.test.ts apps/server/src/modelRoute.test.ts` → 全部通过。
4. 新文件各自一句话职责明确且 `wc -l` ≤300；`pnpm exec tsc -p apps/server/tsconfig.json --noEmit` 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：并行派发实现。
- 2026-09-03：实现与独立审查 APPROVED；编排者复跑指定 4 files / 43 tests 通过。
