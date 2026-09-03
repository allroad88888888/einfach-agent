# 003 R1 独立复审

## 回执

**APPROVED** — 原 Important 与两个 Minor 均已关闭：官方 origin 现为无环单一 owner，adapter/public export/policy 共用同一绑定，测试链实际经过 adapter 调用，三处过时注释也已同步。

## 复审边界

- 仅复核首审的 1 个 Important 与 2 个 Minor；读取更新后的执行报告、当前 `git diff 97a92e9 --`、新增 `providerOrigins.ts` 与相关测试。
- 按要求未重跑报告声称的测试；报告记录修复轮共 38 个测试文件、370 个测试通过。
- 未修改任何产品代码或任务文档；本文件覆盖首审结论。

## Important 闭环

### ✅ 四个官方 base URL 已收口到唯一生产 owner

- `packages/agent-ai/src/providerOrigins.ts:1-5` 是零依赖叶模块，唯一持有 DeepSeek、GLM、Kimi CN、Kimi Global 四个官方 base URL 的生产字面量。
- 生产源码搜索显示这四个完整 origin 字面量只出现在该文件；各测试中的完整 URL 是外部行为期望，不构成生产 owner。
- `providerTransport.ts:1-5,114-120` 直接从该叶模块导入三条路由所需的官方 origin，没有重新硬编码。
- `deepseek.ts:20,190,218`、`glm.ts:16,45,57` 与 `kimiRegion.ts:1,14` 分别消费同一绑定；DeepSeek/GLM 调用与流式调用、Kimi CN/global 选择都不再持有第二份值。

### ✅ 原公开导出保持兼容

- `deepseek.ts:23`、`glm.ts:19`、`kimiRegion.ts:3` 从原模块路径转导对应常量，因此既有内部深链 import 与外部 barrel API 的名字、值和模块入口均未变化。
- `packages/agent-ai/src/index.ts` 继续 export `deepseek`、`glm`、`kimiRegion`；没有额外 export `providerOrigins`，因而不会形成重复 star-export 或导出歧义。

### ✅ 依赖图无环，adapter ↔ policy 断言不是只让 policy 自证

- `providerOrigins.ts` 没有 import；依赖方向为 adapter/`kimiRegion` → `providerOrigins` 与 `providerTransport` → `providerOrigins`。`deepseekMessages → providerTransport` 不会回到 `deepseek`，首审担心的环已由叶模块消除。
- `providerTransport.test.ts:2-6,34-38` 从原 adapter-facing 模块入口读取公开 base URL，再与 policy origin 对比，能锁住旧公开导出与 policy 的同源关系。
- 这条等值断言不是唯一证据：`builtinProviders.test.ts:92-127` 通过真实 `callModel`/provider registry 调用三家 adapter，用注入的 fetch 捕获实际请求 URL，并分别对照从 `deepseek`、`glm`、`kimiRegion` 导出的 base URL。两组测试合起来验证“实际 adapter URL → 原公开绑定 → policy origin”，不是仅从 `PROVIDER_OFFICIAL_ORIGINS` 生成输入和期望的循环断言。

## Minor 闭环

1. ✅ **server 限额注释已更新。** `apps/server/src/modelRouteBody.ts:39-43` 不再引用已删除的 `MAX_PROVIDER_WIRE_REQUEST_BYTES`，明确说明 server 与 host envelope 共同消费 `PROVIDER_TRANSPORT_LIMITS.maxWireRequestBytes`。
2. ✅ **host 发布/声明构建拓扑说明已更新。** `packages/host-node/tsup.config.ts:9-10` 现说明 agent-ai 与 core 均由 manifest dependency 自动 external；`packages/host-node/tsconfig.build.json:5-9` 说明两包必须先产出 dist，并在 `paths` 中新增 `@einfach-agent/ai → packages/agent-ai/dist/index.d.ts`。注释与实际 manifest、声明解析拓扑一致。

## 文件组织与范围

- task `files` 已纳入 `providerOrigins.ts`、三个 adapter 常量原模块以及 host 两个构建配置，R1 变更未越界。
- `providerOrigins.ts` 只有 5 行且只负责官方 origin 常量，符合单一职责；本轮涉及的源码和测试均不超过 300 行。

## 质量发现

### Critical

无。

### Important

无；首审 Important 已关闭。

### Minor

无；首审两个 Minor 已关闭。

## 最终判定

R1 已消除 adapter 与 transport policy 之间的官方 origin 双重权威，保留原公开 API，且同步修正 server 与 host 构建说明；批准交付。
