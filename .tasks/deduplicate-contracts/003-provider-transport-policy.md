---
id: 003
title: 三种运行表面消费同一 provider transport policy
kind: leaf
parent: 000
depends_on: [002]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: 97a92e9
files:
  - packages/agent-ai/src/providerTransport.ts
  - packages/agent-ai/src/providerTransport.test.ts
  - packages/agent-ai/src/providerOrigins.ts
  - packages/agent-ai/src/deepseek.ts
  - packages/agent-ai/src/glm.ts
  - packages/agent-ai/src/kimiRegion.ts
  - packages/agent-ai/src/deepseekMessages.ts
  - packages/agent-ai/src/deepseekMessages.test.ts
  - packages/agent-ai/src/index.ts
  - apps/web/src/modelTransport/providerRoute.ts
  - apps/web/src/modelTransport/providerRoute.test.ts
  - apps/web/src/modelTransport/providerWireBody.ts
  - apps/web/src/modelTransport/providerWireBody.test.ts
  - packages/host-node/src/model/providerRouteCatalog.ts
  - packages/host-node/src/model/providerRoute.ts
  - packages/host-node/src/model/providerRoute.test.ts
  - packages/host-node/src/model/requestBody.ts
  - packages/host-node/src/model/requestBody.test.ts
  - packages/host-node/src/model/requestEnvelope.ts
  - packages/host-node/package.json
  - packages/host-node/tsup.config.ts
  - packages/host-node/tsconfig.build.json
  - apps/server/src/modelRouteBody.ts
  - scripts/model-preview-relay-routes.ts
  - scripts/model-preview-relay-routes.test.ts
  - scripts/model-preview-relay-body.ts
  - scripts/model-preview-relay-body.test.ts
  - pnpm-lock.yaml
---

# 三种运行表面消费同一 provider transport policy

## 目标
由 agent-ai 持有环境中立的 provider route metadata、限额和纯验证规则，Web、host-node 与开发 relay 只做各自信任边界的解码和错误翻译。

## 交付边界
路由表、body/file-name 判据、信封与响应限额、DeepSeek file ID 一致性和三端对拍测试必须共同交付。动态 openai-compatible origin 仍由宿主登记，不下沉凭据或运行时状态。

## 上下文
- 当前 route policy 位于 Web `providerRoute.ts`、host `providerRouteCatalog.ts`、script `model-preview-relay-routes.ts`。
- 共享 wire 类型已在 `packages/agent-ai/src/providerTransport.ts`。
- 当前 Web/host 对 C1 控制字符判断不同；删除路由允许的 DeepSeek ID 与消息引用 validator 不同。
- 不移除 host 对不可信 JSON 的最终校验，只让判据消费同一纯规则。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `ProviderTarget`、`ProviderRequestBody` 与官方 provider base URL。
### 产出
- 环境中立的 route policy/limits/file predicates，供 Web、host、relay 同步消费。

## 验收标准
1. 现有 provider route、wire body、request body、relay 测试全部通过。
2. 新增三端 policy 对拍，覆盖 method/path/bodyKind/response limit 与所有官方 origin。
3. C0/C1 文件名和 DeepSeek file ID 在上传、消息引用、删除三条路径判定一致。
4. `pnpm exec tsc -b packages/agent-ai/tsconfig.json packages/host-node/tsconfig.json apps/server/tsconfig.json tsconfig.app.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：依赖 002 完成，派发执行 agent，base `97a92e9`。
- 2026-09-03：发现 relay body 仍复制 multipart/file-name 判据；扩展 files 纳入 `scripts/model-preview-relay-body.ts` 及测试，以满足既定三端同源验收。
- 2026-09-03：host-node 新增对 `@einfach-agent/ai` 的运行时 import；扩展 files 纳入 package manifest 与 lockfile，要求声明 `workspace:*` 依赖，禁止跨包相对源码导入。
- 2026-09-03：共享 route entry 改变 host catalog 类型来源，纳入其直接 consumer `packages/host-node/src/model/providerRoute.ts`；该接线属于原三端 policy 交付边界。
- 2026-09-03：首审发现 policy 复制官方 origin；R1 纳入 adapter 现有常量文件与新的无环 origin 叶模块，并同步 host 构建拓扑注释。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 8 个关键文件、95 tests 通过，准予提交。
