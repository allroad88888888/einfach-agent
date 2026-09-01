# 020 独立审查

结论：**REVIEW_FAIL**

审查范围严格限于任务 frontmatter 的四个文件；未重跑执行报告已经运行的测试。

## 验收证据

1. ✅ table tests 覆盖 darwin、win32、Linux XDG、Linux fallback 与 custom directory。
   - `appDataPath.test.ts:8-37` 使用 `it.each`，六行分别覆盖 darwin、Windows APPDATA、Windows fallback、Linux XDG、Linux fallback、Windows custom directory。
   - custom directory 的成功案例验证了平台对应的 `win32` 路径语义。

2. ✅ 既有 database path 输出逐项保持不变（静态证据）。
   - `databasePath.ts:68-75` 仍在 application-data 目录下追加 `web-agent.db`。
   - `appDataPath.ts:25-35` 保留原实现的 macOS `Library/Application Support`、Windows `APPDATA`/`AppData/Roaming`、Linux `XDG_DATA_HOME`/`.local/share` 裁决，并统一追加 `com.webagent.app`。
   - `databasePath.ts:61-67` 保留显式绝对 `databasePath` 的最高优先级及相对路径拒绝行为。
   - 执行报告记录定向测试 11 passed；本审查按要求未重复执行。

3. ✅ 缺失输入错误包含平台与缺失字段，且代码没有 cwd fallback。
   - `appDataPath.ts:43-50` 对缺失/空白 `homeDirectory` 抛出含 `platform`、`homeDirectory` 的错误。
   - `appDataPath.ts:38-40,49-50` 对缺失 `env` 抛出含 `platform`、`env` 的错误。
   - `appDataPath.test.ts:39-46` 验证 Linux 缺 home 与 Windows 缺 env 的错误文本。
   - 但 macOS 对不必要 `env` 的错误属于下述 Important 缺陷。

4. ✅ 定向 Vitest 验收命令由执行者报告为通过。
   - `020-report.md` 记录指定命令执行结果为 11 passed；审查未重跑。

5. ✅ 两个实现文件均低于 300 行且职责单一。
   - `wc -l`：`appDataPath.ts` 51 行，`sqlite/databasePath.ts` 76 行。
   - 一句话职责可分别表述为“解析应用数据根目录”和“解析 SQLite 数据库路径”，均不需要并列职责。

## 质量发现

### Critical

无。

### Important

- `appDataPath.ts:23-26` 在判断平台之前调用 `requireEnvironment(input)`，导致 `resolveAppDataDirectory({ platform: 'darwin', homeDirectory: '/home' })` 抛出“缺失 env”。macOS 裁决只依赖 home，旧实现与当前分支都明确不读取环境变量；因此 `env` 在该平台不是必要输入。这个行为收窄了新共享纯函数的有效输入域，也与“缺失必要 home/env 时错误”的必要性口径不符。`appDataPath.test.ts:10-12` 通过注入一个明确会被忽略的 `env` 掩盖了该问题。应把环境校验下沉到 Windows/其他平台分支，并补一个不传 `env` 的 darwin case。

### Minor

无。

## 规则与边界检查

- 未发现 rollout 文件名、目录创建或文件系统访问。
- 测试输入显式注入，没有读取真实用户环境来完成跨平台 table tests；SQLite 既有宿主测试仍按其运行时装配合同使用 `process`。
- 四个范围文件分别为 51、47、76、60 行，无超限、机械拆分或大杂烩命名。

## R1 复审

结论：**REVIEW_PASS**

本轮只核验 R0 的 Important 发现及对应回归用例，未重跑执行者测试。

- ✅ `appDataPath.ts:23-26` 已先处理 darwin，再对 Windows/Linux 调用 `requireEnvironment`；macOS 现在只要求实际依赖的 `homeDirectory`，原 Important 已关闭。
- ✅ `appDataPath.test.ts:9-12` 的 darwin table case 已省略 `env`，直接覆盖并防止该问题回归。
- ✅ 更新后的执行报告记录 R1 定向 Vitest 11 passed、TypeScript build 与 `git diff --check` 通过；本轮按要求仅核验报告，不重复执行。
- ✅ 修复只落在任务 owner `packages/host-node/src/appDataPath.ts` 与 `packages/host-node/src/appDataPath.test.ts`，未见越界。

R1 未发现阻止通过的新问题。
