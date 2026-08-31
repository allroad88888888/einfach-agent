# 010 执行报告：固化 Web 两态契约

## 改动摘要

- 当前工作区已将 `createHostModelCredentialHost()` 固化为三条互斥路径：`server` 始终使用 server 凭据宿主；`static + DEV` 使用 unavailable 宿主配合开发中继；生产 `static` 使用浏览器 localStorage BYOK 宿主。
- 当前工作区测试已为生产 `static` 增加浏览器凭据宿主哨兵与断言，并保留 `server` 优先于 `DEV` 的断言。
- 现有定向测试已经直接覆盖：健康握手解析为 `server`；失败、超时、非健康、无效载荷解析为 `static`；`static` 不登记 bridge；`server` 登记 HTTP bridge；`static` 使用 IndexedDB；`server` 使用 HTTP SQL executor/SQLite。
- 上述两处产品改动在本任务开始时已存在于 `hostModelCredentialHost.ts` 与 `hostModelCredentialHost.test.ts` 的未提交工作区中；本执行保留并验证它们，没有覆盖或改写已有改动，也没有提交。
- `one-file-one-thing` 自检通过：任务边界内 8 个文件分别为 166、140、66、117、24、96、76、101 行，均不超过 300 行；本次没有新增职责或文件。

## 逐条验收命令与结果

### 1. 定向 Vitest

命令：

```sh
pnpm exec vitest run apps/web/src/host/resolveHost.test.ts apps/web/src/host/hostCommandBridge.test.ts apps/web/src/host/hostModelCredentialHost.test.ts apps/web/src/persistence/persistenceDrivers.test.ts
```

结果：通过。`4 passed`，共 `25 passed`，退出码 0。

覆盖结论：

- `resolveHost.test.ts` 覆盖 server 健康握手，以及 static 的 unreachable、timeout、unhealthy、unrecognized 回落。
- `hostCommandBridge.test.ts` 覆盖 server 有 HTTP bridge，static 无 bridge 且不读取 token。
- `hostModelCredentialHost.test.ts` 覆盖 server 凭据宿主、生产 static 浏览器 BYOK、开发 static unavailable 三条路径。
- `persistenceDrivers.test.ts` 覆盖 static IndexedDB 与 server SQLite/HTTP SQL executor 两条路径。

### 2. Tauri Web 运行时禁用模式扫描

命令：

```sh
rg -n "@tauri-apps/|HostKind.*tauri|kind: 'tauri'" apps/web/src
```

结果：未满足“无匹配”字面标准。退出码 0，发现 2 个匹配，均为任务 files 边界外的历史注释：

```text
apps/web/src/test/setup.ts:18:// 把真 @tauri-apps/api 灌进 worker 模块图，导致 Tauri mock 全部失效（B1 后的回归教训）。
apps/web/src/persistence/serverSqlExecutor.ts:3:// 与桌面态的 `tauriSqlExecutor.ts` 是兄弟文件：那边把 `@tauri-apps/plugin-sql` 的 `Database`
```

补充运行时代码扫描：

```sh
rg -n "from ['\"]@tauri-apps/|import\(['\"]@tauri-apps/|HostKind.*tauri|kind: 'tauri'" apps/web/src
```

结果：无匹配。当前扫描未发现 `@tauri-apps/*` 的静态/动态 import，也未发现 `HostKind`/`kind` 的 `tauri` 成员。

### 3. TypeScript project build

命令：

```sh
pnpm exec tsc -b
```

结果：通过，退出码 0，无输出。

### 4. 补充质量检查

命令：

```sh
git diff --check -- apps/web/src/host/resolveHost.ts apps/web/src/host/resolveHost.test.ts apps/web/src/host/hostCommandBridge.ts apps/web/src/host/hostCommandBridge.test.ts apps/web/src/host/hostModelCredentialHost.ts apps/web/src/host/hostModelCredentialHost.test.ts apps/web/src/persistence/persistenceDrivers.ts apps/web/src/persistence/persistenceDrivers.test.ts
```

结果：通过，退出码 0，无空白错误。

## 未验证项

- 未运行浏览器或 Tauri 端到端模式验证；该验证属于依赖 010/040 的 050 节点。
- 未运行任务范围外的全量 `pnpm test`；索引已记录其被用户删除的 `UndoBar.tsx` 对应 invariant 测试阻塞。

## 范围外发现

- `apps/web/src/test/setup.ts:18` 与 `apps/web/src/persistence/serverSqlExecutor.ts:3` 的注释含 `@tauri-apps/`，导致验收标准 2 的原命令出现匹配。两文件不在 010 的 files 边界内，未修改。

## 疑虑

- 验收标准 2 的命令同时扫描注释与可执行 import，和“Web 运行时代码不得依赖 Tauri”的语义目标不完全等价。当前可执行 import 的补充扫描为零匹配，但原命令仍不能报告通过。
- `hostModelCredentialHost.ts` 与其测试的任务相关改动在本执行开始前已存在；本执行只能确认其内容、定向测试和类型检查均符合 010 契约，不能将其来源归为本执行。

## 建议后续动作

- 由拥有 `apps/web/src/test/setup.ts` 与 `apps/web/src/persistence/serverSqlExecutor.ts` 边界的任务删除/改写两处过时注释，或由编排者把验收命令收窄为实际 import 与联合类型成员扫描；随后重跑验收标准 2。
- 050 节点继续用同一个 `resolveHost()` 对纯静态 URL 与 Tauri sidecar URL 做模式冒烟验证。
