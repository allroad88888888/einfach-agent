APPROVED

# final I-1 R1 独立复审

## 结论

R1 已修复前轮 Windows 阻断：测试不再启动 `pnpm.cmd`，而是从当前测试模块的 Node 解析上下文找到实际安装的 `tsup/package.json`，读取 package `bin` 后用 `process.execPath` 直接执行 tsup 的 JavaScript CLI。该路径不依赖 shell、PATH 或平台 shim，在 Windows/POSIX 及路径含空格时都由 `execFile` 的 argv 边界安全处理。

`@einfach-agent/ai` 的直接依赖、lock importer、真实临时 tsup 构建与 externalization 原结论仍成立。新增 bare import/matcher helper 用例通过，文件职责与行数合格。

**当前没有 Critical 或 Important 阻断项。**

审查基线：`67de8f5`。只读核对范围：

- `apps/server/package.json`
- `apps/server/tsup.config.ts`
- `apps/server/src/packageBoundary.test.ts`
- `pnpm-lock.yaml`
- `.tasks/deduplicate-contracts/reports/final-review.md`

本 reviewer 未修改产品代码、未提交，只覆盖本 review 报告。

## Findings

### Critical

无。

### Important

无。

### Minor

无阻断性 minor。

## R1 修复核对

### tsup CLI 跨平台启动：✅

- `packageBoundary.test.ts:3,12-20` 使用 `createRequire(import.meta.url)`；`require.resolve('tsup/package.json')` 遵循 Node 标准包解析，从测试实际所在 workspace 向上解析当前安装的 tsup，不硬编码 pnpm virtual-store 路径。
- package `bin` 同时兼容 npm 允许的 string 与 object 两种形状；object 路径读取 `bin.tsup`，缺失时立即以明确错误 fail closed。
- `resolve(dirname(tsupManifestPath), tsupBin)` 从 manifest 所在包根解析相对 bin。本机实查得到当前真实安装的 `tsup/dist/cli-default.js`，不是 `.bin` shim，也不是旧 server dist。
- `packageBoundary.test.ts:108-112` 以 `process.execPath` 为 executable、tsup CLI 为第一个 argv。Node 可在所有支持平台直接启动 JavaScript entry；文件路径和 outDir 即使含空格也不会经过 shell 拆词。
- 该方案不再有前轮 `execFile('pnpm.cmd')` 的 Windows 限制，也不依赖用户 PATH 上是否存在 pnpm。

### bare import 与 matcher helper：✅

- `externalImportPattern`（78-81）现在同时接受：静态 named/re-export 的 `from "pkg"`、dynamic `import("pkg")`、bare side-effect `import "pkg"`，并继续允许 package subpath。
- 表驱动 helper 用例（83-89）逐一固定 named、dynamic、bare 三种输出形状；相邻包名用例（91-93）确认 `@einfach-agent/ai-extra` 不会被误认成 `@einfach-agent/ai`。
- AST source scanner 原有判断仍正确：纯 type import/export 被忽略，混合 type/value、side-effect/default/namespace import、value/star/namespace re-export、字符串字面量 dynamic import 被计为 runtime dependency；subpath 统一归到 package root。
- production source 仍只纳入现有 server 约定的 `.ts`，并排除 `.test.ts`、`.testHarness.ts`、`.testFixtures.ts`；实查当前目录没有漏掉其它生产扩展名或 fixture 命名。

### manifest 与 lock importer：✅

- `apps/server/package.json:31-35` 将 `@einfach-agent/ai: workspace:*` 声明在运行时 dependencies，与源码直接 value import 对齐。
- `pnpm-lock.yaml:161-171` 的 `apps/server` importer 同步记录 `specifier: workspace:*`、`version: link:../../packages/agent-ai`；路径与 workspace 结构正确。
- 当前生产源码识别出的 runtime workspace packages 仍是 ai/core/host-node，manifest 三项全部覆盖。`apps/server/tsup.config.ts:15-18` 的注释与共享 `getProductionDeps` 自动 external 事实一致，无需手写 external 重复名单。

### 真实 externalization 与旧 dist 隔离：✅

- 边界测试继续用 `mkdtemp` 创建唯一输出目录，从 `apps/server` cwd 加载真实 `tsup.config.ts` 并以 `--out-dir` 指向该临时目录；不是读取已有 bundle 的文本测试。
- 构建结束后读取临时目录中新生成的 `main.js`，逐个要求发现到的 workspace package 保留 external import；因此未声明依赖导致的静默内联会使断言失败。
- `finally` 递归清理的目标是刚创建的明确临时目录。不同 worker/process 不共享 outDir，没有 server dist 清理竞争。
- 本轮测试前仓库 `apps/server/dist/main.js` 的 mtime 为 15:59:06；15:59:53 开始的定向测试完成后仍为 15:59:06，确认 R1 测试没有读取后覆盖或依赖旧 dist 输出。

### 定向验证：✅

执行：

```text
pnpm exec vitest run apps/server/src/packageBoundary.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
Duration    1.85s
```

另外：tracked 范围 `git diff --check` 无输出；未跟踪测试以 `git diff --no-index --check` 检查也无空白错误。

### one-file-one-thing 与行数：✅

- `packageBoundary.test.ts` 为 118 行，低于普通文件 300 行硬门槛。
- 文件仍可由一句话描述：验证 server 的 runtime workspace imports 均声明为直接依赖并在真实 bundle 中 externalize。parser、matcher 与构建断言共同服务同一个 package boundary 契约，没有独立业务职责混杂。
- `apps/server/tsup.config.ts` 19 行；manifest 与 lockfile 分别是依赖声明和生成账本，无行数/SRP 问题。

## 验证建议

- 合并前可在 Windows CI 跑同一条定向测试，作为环境实证；静态复审未发现 Windows 特有的剩余启动或路径问题。
- 后续若 server 引入 `.mts`/`.tsx` 生产文件或无替换模板字面量 dynamic import，应同步扩展 source pattern/AST literal 支持；当前 server 文件集合与编码形态不受影响。

最终回执：`APPROVED` — R1 已消除 Windows 进程启动阻断，依赖、lock、真实 externalization、fixture 过滤、并发隔离与行数均通过；**没有剩余阻断项**。
