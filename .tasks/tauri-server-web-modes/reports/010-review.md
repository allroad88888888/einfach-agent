# 010 首轮独立审查：固化 Web 两态契约

## 结论

**REJECTED**。范围 diff 中的凭据宿主改动符合任务描述，但验收标准 1 要求的“新增断言”未完整出现在本次范围 diff，且验收标准 2 的原命令据执行报告明确产生了匹配。

## 审查依据与边界

- 任务文件：`.tasks/tauri-server-web-modes/010-web-mode-contract.md`
- 执行报告：`.tasks/tauri-server-web-modes/reports/010-report.md`
- 指定 base `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 到当前工作区的 8 个范围文件 diff
- 按要求未重跑执行报告已声明运行的测试或类型检查。
- 指定 diff 实际只有 `hostModelCredentialHost.ts` 与 `hostModelCredentialHost.test.ts` 两个文件发生变化；另外 6 个指定文件没有范围 diff。

## 验收标准逐条判定

### 1. 定向 Vitest 与新增覆盖：❌

证据：

- 执行报告记录指定 Vitest 命令退出码为 0，结果为 `4 passed`、`25 passed`；按审查要求未重跑。测试通过这一部分有报告证据。
- diff 在 `hostModelCredentialHost.test.ts` 新增浏览器凭据宿主哨兵与 mock，并把生产 `static` 用例从 unavailable 改为断言 `browserHostValue`；同时保留 `server + DEV` 仍选择 server、`static + DEV` 选择 unavailable 的断言。凭据路径新增覆盖符合要求。
- 但是 `hostCommandBridge.test.ts` 与 `persistenceDrivers.test.ts` 在指定 base 后没有任何 diff，因此本次变更没有为 “static 无 bridge、server 有 bridge、两种持久化路径” **新增断言**。执行报告只说明这些断言在现有测试中已经存在，不能证明验收标准字面要求的新增覆盖。

因此，命令通过但附加的“新增断言覆盖”条件未完整满足，本条整体判为 ❌。

### 2. Tauri Web 运行时禁用模式扫描：❌

证据：

- 执行报告记录原验收命令 `rg -n "@tauri-apps/|HostKind.*tauri|kind: 'tauri'" apps/web/src` 退出码为 0，并命中 2 处：`apps/web/src/test/setup.ts:18` 与 `apps/web/src/persistence/serverSqlExecutor.ts:3`。
- 这两处位于任务 diff 之外，未在本审查中读取；其具体上下文为 **⚠️无法核实**，不据此提出产品代码质量缺陷。但原命令是否“无匹配”已经由执行报告的结果直接证明为否。
- 执行报告中的补充 import 收窄扫描无匹配，能支持“没有可执行 Tauri import”的语义判断，却不能替代任务文件规定的原命令。
- 指定范围 diff 没有引入 `@tauri-apps/`、`HostKind ... tauri` 或 `kind: 'tauri'`；该事实不能让全目录原命令变成无匹配。

因此，本条按任务文件的字面命令判为 ❌。

### 3. TypeScript project build：✅

证据：

- 执行报告记录 `pnpm exec tsc -b` 退出码为 0、无输出；按审查要求未重跑。

## 实现契约核对

- ✅ `hostModelCredentialHost.ts` 先判断 `host.kind === 'server'`，所以 server 在 DEV 下仍使用 `createServerModelCredentialHost()`。
- ✅ 非 server 且非 DEV 时使用 `createBrowserModelCredentialHost()`，符合任务上下文要求的生产 static 浏览器凭据路径。
- ✅ static + DEV 继续使用 `createUnavailableModelCredentialHost()`，与执行报告描述一致。
- ✅ 范围 diff 没有扩展 `HostKind`，没有加入 Tauri import、全局变量或依赖。
- ✅ 指定范围内 8 个文件的行数由执行报告记录为 166、140、66、117、24、96、76、101，均低于 300 行；本次变更涉及的文件职责仍分别聚焦于凭据宿主选择及其测试。

## 质量发现

### Critical

无。

### Important

1. **验收扫描的规定命令仍失败。** 即使两个命中据报告只是范围外历史注释，当前任务的验收标准明确要求该命令无匹配；在任务标准或范围外文本被调整前，不能宣称本项完成。
2. **“新增断言”交付与范围 diff 不一致。** bridge 与 persistence 测试在 base 后未变化；现有断言可证明当前行为，但不满足验收标准要求这些类别具有新增断言的字面条件。应由任务所有者明确接受既有覆盖，或在任务范围内补充有价值且不重复的保护性断言。

### Minor

无。

## 修复后复审条件

- 使验收标准 2 的原始 `rg` 命令无匹配，或由任务所有者正式修改该验收标准，使其只扫描可执行 import/联合类型成员。
- 补足 bridge、persistence 的新增保护性断言，或由任务所有者明确把“新增断言”改为“现有断言覆盖”。

---

# 010 编排裁决后独立复审：固化 Web 两态契约

## 复审结论

编排者已明确以“现有覆盖”和“可执行依赖扫描”为本轮验收口径；首轮关于“必须新增断言”及“注释命中扫描”的拒绝理由不再适用。基于当前任务文件、执行报告、首轮审查与指定 base 到当前工作区的 8 文件范围 diff，本轮结论为通过。

## 验收标准逐条判定

### 1. 定向 Vitest 与现有覆盖：✅

- 执行报告记录指定 Vitest 命令退出码为 0，结果为 `4 passed`、`25 passed`；遵照要求未重跑报告已声明运行的测试。
- 执行报告逐项记录现有测试已覆盖：健康握手为 `server`，失败、超时、非健康及无效载荷回落为 `static`；`static` 不登记 bridge、`server` 登记 HTTP bridge；`static` 使用 IndexedDB、`server` 使用 HTTP SQL executor/SQLite。
- 范围 diff 在 `hostModelCredentialHost.test.ts` 增加浏览器凭据宿主哨兵，并明确覆盖 `server`、生产 `static`、开发 `static` 三条互斥路径。编排者已接受其余类别使用现有断言，因此无需以“对应测试文件必须产生 diff”作为拒绝条件。

### 2. Web 可执行 Tauri 依赖与第三态扫描：✅

- 执行报告记录可执行依赖扫描无匹配：未发现来自 `@tauri-apps/*` 的静态或动态 import，也未发现 `HostKind` 或 `kind` 的 `tauri` 成员。
- 原宽泛扫描命中的两处均为注释；按编排者明确的“可执行依赖扫描”口径，它们不构成 Web 运行时依赖。
- 指定范围 diff 只新增 `browserModelCredentialHost` 的普通 Web import，没有加入 Tauri import、全局变量、依赖或第三种 host kind。

### 3. TypeScript project build：✅

- 执行报告记录 `pnpm exec tsc -b` 退出码为 0、无输出；遵照要求未重跑。

## 实现契约核对

- ✅ `hostModelCredentialHost.ts` 首先判断 `host.kind === 'server'`，保证 server 即使处于 DEV 仍使用 `createServerModelCredentialHost()`。
- ✅ 非 server 且非 DEV 的生产 `static` 使用 `createBrowserModelCredentialHost()`；`static + DEV` 使用 unavailable 宿主，三条路径与任务上下文及执行报告一致。
- ✅ diff 中的测试用互异哨兵按返回身份钉住上述三条路径，并显式控制 `import.meta.env.DEV`，避免依赖 Vitest 默认环境。
- ✅ `git diff --check` 对指定范围无输出；8 个范围文件当前分别为 166、140、66、117、24、96、76、101 行，均低于 300 行，且本次变更仍只负责凭据宿主选择及其测试，符合 `one-file-one-thing` 规则。

## 质量发现

### Critical

无。

### Important

无。

### Minor

无。

APPROVED 现有测试覆盖、可执行依赖扫描、类型构建与范围实现共同证明 Web 两态契约已固化。
