---
id: '030'
title: 接口工具包可查询和标准化页面候选数据
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files:
  - browser-agent/tools/api/**
---

# 接口工具包可查询和标准化页面候选数据

## 目标与交付边界

一个 `@einfach-agent/tools-browser-api` 包提供 `query_options`，按宿主已注册的数据源查询选项、搜索与分页，
标准化为可交给页面工具的 label/value。含源注册、请求适配、错误分类、测试与独立接入说明。
和页面包分开：本包不读写 DOM，业务系统能仅复用它；不为每个 endpoint 再建一个框架层或 issue。

## 上下文与覆盖

- 复用 `@einfach-agent/core/tools` 的 Tool、ToolContext、ToolRegistry；参照 `tools/interaction/src/index.ts` 注册范式。
- 010 只准备工作区与公共构建，不需要从 Agent 包引入配置单例。
- 覆盖 C07。当前没有真实客户接口；用一份确定性 JSON fixture 与可注入 fetch，不假定任何实际业务 URL。
- 模型连接的 API key 与业务数据源凭据不是一回事；业务认证由宿主提供，tool args 不接收凭据。

## 接口（本任务新增、供 050 消费）

```ts
interface QueryOptionsInput {
  sourceId: string; query?: string; cursor?: string;
  parameters?: Readonly<Record<string, string | number | boolean>>;
}
interface QueryOptionsResult {
  options: readonly { label: string; value: string }[];
  nextCursor?: string;
}
type ApiCallContext = Pick<ToolContext, 'sessionId' | 'signal'>;
interface ApiToolsHost {
  queryOptions(input: QueryOptionsInput, ctx: ApiCallContext): Promise<QueryOptionsResult>;
}
interface OptionsSource {
  id: string;
  query(input: Omit<QueryOptionsInput, 'sourceId'>, ctx: ApiCallContext): Promise<QueryOptionsResult>;
}
function createApiToolsHost(sources: readonly OptionsSource[], options: {
  isSourceAllowed(sourceId: string, sessionId: string): boolean;
}): ApiToolsHost;
function registerApiTools(registry: ToolRegistry, host: ApiToolsHost): void;
```

提供一个 fetch 数据源实现示例/工厂以验证 HTTP 错误和取消；具体响应路径映射留在注册的 source adapter 中，
不让模型传任意 URL、headers、HTTP method 或执行表达式。对于不同业务的适配扩展公开 OptionsSource 即可。

## 行为要求

1. sourceId 必须存在且通过宿主注入的 isSourceAllowed；sessionId 只从可信 ToolContext 取，不信模型自报身份。
   这是业务数据源授权，不等于 core 对 query_options 整个工具的 allowlist；不新增另一套 Agent 配置 UI。
2. 验证 query、分页和参数；返回 label/value 与 cursor，不暴露完整服务器返回、headers、token 或内部对象。
3. 支持普通下拉、关键词搜索、依赖父字段过滤、分页；最大结果数有上限，超限明确截断/分页。
4. 区分空结果、超时、取消、401/403、非 JSON/畸形响应、429/服务错误；错误脱敏，响应失败不缓存成成功空列表。
5. 只查询数据；业务源即使采用 POST 也必须声明/实现查询语义，不提供通用任意写请求工具。
6. 取消信号传入 fetch/源适配，迟到结果不再驱动下一步写表。没有默认无限重试，不读取全局浏览器凭据。

## 验收标准

1. `pnpm exec vitest run browser-agent/tools/api`：搜索、父字段过滤、分页、字段映射、未知 source、重复注册、截断；
   两个 session 对同一 source 授权不同，拒绝方不得触发 query/fetch。
2. 注入 fetch/host 的 HTTP 错误与取消场景；断言 ToolResult 中没有 API key、认证头、原始秘密响应。
3. 独立 core 注册 query_options 成功执行；无需 ui、extension、DOM 或客户后端进程。
4. `pnpm --filter @einfach-agent/tools-browser-api build` 通过；README 给出确定性 fixture 和真实系统 OptionsSource 接入例。
5. 结果可直接供 page.fill_fields 使用，但测试不能 import page 内部文件；跨包 E2E 由 050 验收。

## 执行记录

- 2026-09-18：010 已交接本包骨架；仅消费现有 core/tools，取消对 BrowserAgentClient 实现的串行等待并派发。
- 本包已有未提交 manifest/空入口/构建配置作为输入；现在本任务独占 browser-agent/tools/api/**，可补齐自己的 build/exports。
- 报告 `reports/030-report.md`，审查 `reports/030-review.md`。不得修改 page、agent、core 或根 lockfile。

- 2026-09-18：执行者交付 DONE，进入独立审查；尚未标为 done。

## R1 修复

- 独立审查 reports/030-review.md REJECTED；关闭三个 Important：真实请求截止时间、取消/超时后的迟到结果围栏、按稳定 code 映射安全错误文案。
- 超时应由宿主配置（有有限默认值），不能让模型调整。作用于整个 query 生命周期，含 fetch/读取响应；对于不配合 signal 的 source，宿主仍须按时拒绝并丢弃迟到结果，同时取消传入 adapter 的 signal，清理 timer/listener。
- 错误边界对来源自带 message 不做透传；保留稳定分类与 retryable，API secret/原始 body/URL 不进入 ToolResult。
- 补永不 settle、迟到 resolve、body 读取取消、带秘密 ApiToolsError 负例；改动限本包与原报告。报告列明 timeout 公共签名。
- 编排者亲验原版定向测试：page+api 8 files/26 tests passed；不能据此替代新增负例。

- 2026-09-18：R1交付DONE，17项定向测试通过，复审 reports/030-review-r1.md；新增宿主timeoutMs有限默认10秒/上限120秒。

- 2026-09-18：R1独立复审PASSED，编排亲验17项API测试通过，030标done。Minor：同栈abort后已排队source微任务仍启动一次但signal已aborted，外层拒绝且迟到结果丢弃；只读源范围内接受，不进入修复循环。
