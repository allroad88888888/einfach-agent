# 015 包边界与运行时集成复审报告

## 结论

APPROVED。对 `55a3d2e..2eee1e1` 的独立复审未发现 Critical、Important 或 Minor 缺口。直接运行时依赖、lock importer、公开 exports、tsup externalization、浏览器/Node 边界、provider policy 接线和发布闭包均闭合；原审查第 10 项保持明确跳过。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 审查证据

### 1. Manifest、lock 与运行时 import 一致

- `apps/server/src/modelRouteBody.ts:29` 是 server 对 `@einfach-agent/ai` 的直接运行时 import；`apps/server/package.json:31-35` 已把 `ai`、`core`、`host-node` 全部列为 `dependencies`，`pnpm-lock.yaml:161-170` 的 `apps/server` importer 同步为对应 workspace link。
- 对 server 全部生产 `.ts` 使用 TypeScript AST 重新枚举运行时 import，结果只有 `@einfach-agent/ai`、`@einfach-agent/core`、`@einfach-agent/host-node`，三者均已声明；type-only import 未误判成运行时依赖。
- 对 host-node 全部生产 `.ts` 做同样枚举，运行时 workspace import 只有 `@einfach-agent/ai`、`@einfach-agent/core`、`@einfach-agent/persistence-sqlite`。三者分别出现在 provider policy 消费、历史/rollout 契约和 `packages/host-node/src/history/historyRecoveryReader.ts:1`，均由 `packages/host-node/package.json:33-37` 声明；`pnpm-lock.yaml:227-240` importer 完全一致。
- `packages/agent-ai` 的生产源码没有第三方、workspace 或 `node:*` 运行时 import，其空运行时依赖 manifest 与源码一致。

### 2. 公开 exports 与真实发布安装闭合

- `@einfach-agent/ai` 仍只公开根入口，manifest 的 `exports["."]` 指向 `dist/index.js` / `dist/index.d.ts`（`packages/agent-ai/package.json:17-25`），共享 transport policy 已经由根 barrel 导出（`packages/agent-ai/src/index.ts:28-33`），消费方没有依赖未公开深路径。
- `@einfach-agent/host-node` 同样保持单一根入口（`packages/host-node/package.json:20-28`），server 使用的模型转发面继续由 `src/index.ts` 经 `src/model/index.ts` 公开；没有新增发布后无法解析的 subpath。
- `pnpm check:dist` 通过：18 个真实 tarball、28 个公开 ESM 入口均能在仓库外 consumer 中导入，NodeNext 声明检查及负向 exports 检查均通过。
- `PACKED_SERVER_SKIP_BUILD=1 pnpm check:packed` 解析到的发布闭包为 `server → {ai, core, host-node}`、`host-node → persistence-sqlite`；仓库外安装后 server 成功启动，health、认证、Host 调用、SQLite 写入/重开读取及无残留退出五项均通过。这也直接证明 follow-up `2eee1e1` 不再在安装后缺失 `@einfach-agent/ai`。

### 3. tsup externalization 没有静默重复打包

- 共享预设明确依赖 tsup 从当前包 manifest 读取 `dependencies` / `peerDependencies` 并 externalize（`tsup.preset.ts:18-25`）；server 的边界测试从 package cwd 调用真实 tsup，并同时断言“源码运行时 import 已声明”和“bundle 仍保留外部 import”（`apps/server/src/packageBoundary.test.ts:94-118`）。该测试本轮通过。
- 独立把当前源码的 `agent-ai`、`host-node`、`server` 分别构建到临时目录并检查产物：
  - `agent-ai/index.js` 不含外部 import，三条官方 origin 各出现一次；
  - `host-node/index.js` 保留 `@einfach-agent/ai`、`@einfach-agent/core/history`、`@einfach-agent/persistence-sqlite` 外部 import，三条官方 origin 均未被内联；
  - `server/main.js` 保留 `@einfach-agent/ai`、`@einfach-agent/core/history`、`@einfach-agent/host-node` 外部 import，三条官方 origin 均未被内联。
- 包间 manifest 图无环：`agent-ai → ∅`，`core → ai`，`persistence-sqlite → core`，`host-node → {ai, core, persistence-sqlite}`，`server → {ai, core, host-node}`。未发现跨包循环或同一 policy 被打进多份 Node 产物。
- `removeNodeProtocol: false` 仍由共享预设统一设置（`tsup.preset.ts:72-89`）；真实 packed-server SQLite 落盘门禁通过，说明 Node builtin 没有在发布构建中被错误改写成第三方包说明符。

### 4. 浏览器与 Node 运行时边界清晰

- policy owner `packages/agent-ai/src/providerTransport.ts` 只使用 `TextEncoder`、`Blob`、`AbortSignal`、`Response` 等 Web/Node 22 共有能力；整个 `packages/agent-ai/src` 生产代码没有 `node:*`、`Buffer`、`process` 或 Node 包 import。
- Web 的 route、wire body 与 envelope 从 `@einfach-agent/ai` 根入口消费共享 policy/predicate（例如 `apps/web/src/modelTransport/providerRoute.ts:13-19`、`providerWireBody.ts:1-10`），没有 import `@einfach-agent/host-node`。
- 当前源码的临时 Vite production build 成功；生成的 13 个 JS asset 中没有 `node:*` import，也没有 `@einfach-agent/host-node` package specifier。Node-only host 实现未污染浏览器产物。
- server 的 HTTP body 上限直接消费 `@einfach-agent/ai`，模型路由执行则经公开的 `@einfach-agent/host-node` 转发面进入 Node 安全边界；浏览器 policy 识别不是安全边界，host 仍独立收窄外部输入。

### 5. Provider policy 单一 owner 与四个运行表面接线

- 官方 origin 字面量只在 `packages/agent-ai/src/providerOrigins.ts:1-5` 定义；method/path/body/response limit、multipart 元数据谓词与 DeepSeek file-id 判据集中在 `packages/agent-ai/src/providerTransport.ts:7-72,114-217`。
- Web 通过 `findProviderRoutePolicy` / `PROVIDER_OFFICIAL_ORIGINS` 消费；host-node 从同一 `PROVIDER_ROUTE_POLICIES` 投影 host origin binding（`packages/host-node/src/model/providerRouteCatalog.ts:1-31`）；relay 直接消费同一源码 owner（`scripts/model-preview-relay-routes.ts:1-5,55-76`）；server 分别经 `ai` limits 与 host-node route 转发消费。没有发现第二份生产 route 表、官方 origin 字面量或响应上限表。
- 定向 parity/边界测试共 6 files、72 tests 通过，覆盖共享 policy owner、Web/host/relay 全量官方路由一致性、body metadata 判据、DeepSeek file-id 删除路径和 server 真实 externalization。

### 6. 明确跳过的第 10 项

- `git diff 55a3d2e..2eee1e1` 对 `deepseekFiles.ts`、`deepseekFileDisposal.ts`、`kimiFiles.ts`、`kimiFileDisposal.ts` 均无改动；本次只把传输层 file-id/route 判据收敛到共享 policy，没有合并两家 provider 的文件生命周期或 adapter 生命周期。
- 因此第 10 项保持“明确不做”，既未被暗中实施，也未由包重构造成跨 provider 生命周期耦合。

## 本轮验证

- `pnpm exec vitest run apps/server/src/packageBoundary.test.ts packages/agent-ai/src/providerTransport.test.ts packages/host-node/src/model/providerRoute.test.ts apps/web/src/modelTransport/providerRoute.test.ts scripts/model-preview-relay-routes.test.ts scripts/model-preview-relay-body.test.ts`：6 files / 72 tests passed。
- `pnpm check:dist`：18 packed packages / 28 public ESM entry points passed；NodeNext declarations 与负向 exports 检查通过。
- `PACKED_SERVER_SKIP_BUILD=1 pnpm check:packed`：仓库外安装及五项真实运行时门禁通过。
- 当前源码临时 tsup 构建：`agent-ai`、`host-node`、`server` 全部通过，external import 与 origin 计数符合预期。
- 当前源码临时 Vite production build：通过；无 Node-only import/package specifier。
- `git diff --check 55a3d2e..2eee1e1`：通过。

所有临时构建目录均已清理；除本报告外未修改产品代码或其它交付文件。
