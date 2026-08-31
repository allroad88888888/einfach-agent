# 030 暂存 Node runtime：独立审查

## 结论

**APPROVED**。三条验收标准均有任务范围内的实现与执行报告证据，未发现 Critical 或 Important 问题。

## 审查范围与方法

- 基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`。
- 指定的五个产品文件均为 untracked，因此普通范围 diff 为空；已逐个使用 `git diff --no-index -- /dev/null <file>` 阅读完整新增 diff。
- 按要求未重跑执行报告中声称已运行的测试、staging、版本检查或 Git 忽略检查；以下运行结果均引用执行报告。
- 新增文件物理行数分别为 4、1、164、42、29，均低于 300 行；脚本、测试、忽略规则与文档各自职责清楚，未违反 one-file-one-thing 规则。

## 验收标准逐条判定

### 1. stager 测试覆盖 target 映射、SHA-256 不匹配、缺失 archive 和输出命名

✅ **通过**。

证据：

- `testTargetMapping()` 断言 Apple ARM64 与 Windows x64 archive 映射，并断言未知 target 被拒绝。
- `testArchiveVerification()` 分别断言缺失 archive 抛出 `Missing Node archive`、正确摘要通过、错误摘要抛出 `SHA-256 mismatch`。
- `testOutputNaming()` 断言 Unix 输出无扩展名、Windows 输出带 `.exe`，且均带完整 target triple。
- 执行报告记录 `node scripts/stage-desktop-node-runtime.test.mjs` 输出 `stage-desktop-node-runtime tests passed`。

### 2. 当前主机 staging 后 binaries 仅含被忽略 executable 与 `.gitkeep`，Git 状态不出现二进制

✅ **通过**。

证据：

- `.gitignore` 以 `binaries/*` 忽略 sidecar，并以 `!binaries/.gitkeep` 保留占位文件；`.cache/` 同样被忽略。
- stager 将结果写入 `apps/desktop/binaries/einfach-agent-node-<target>[.exe]`，符合忽略模式与约定命名。
- 执行报告记录在当前 Apple Silicon 主机成功暂存 `einfach-agent-node-aarch64-apple-darwin`；`find` 结果仅有该 executable 与 `.gitkeep`。
- 执行报告记录限定到 `apps/desktop` 的 `git status --short --untracked-files=all` 只显示待提交的 `.gitignore` 与 `.gitkeep`，未显示 sidecar 或缓存；`git check-ignore -v` 也分别命中 `binaries/*` 与 `.cache/`。

### 3. staged executable 的 Node 版本满足 `>=22.13.0`

✅ **通过**。

证据：

- 实现将 `NODE_VERSION` 固定为 `22.13.0`，下载 URL、archive 名与解压目录均由该版本构造。
- 执行报告记录 staged executable 可执行且 `--version` 输出 `v22.13.0`，满足下限。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. **target 映射测试只抽查了部分表项。** `releases` 有 8 个 target，但测试只具体断言 `aarch64-apple-darwin` 与 `x86_64-pc-windows-msvc`，未逐项锁定 x86 macOS、两个 Linux GNU、Windows ARM64 与两个 GNU alias 的 archive 名和平台属性。当前实现的映射从 diff 看一致，但未抽查的表项若以后误改，现有测试可能不会失败。
2. **失败路径可能残留临时 sidecar。** `temporaryOutputPath` 在 extraction `try` 内创建，却没有在 `finally` 中删除；若 `copyFile`、`chmod` 或最终 `rename` 失败，`binaries/` 中可能留下 `<output>.<pid>.tmp`。该文件仍被 Git 忽略，且不影响报告中的成功路径，但会造成失败后的本地垃圾文件。

## 无法核实

- ⚠️无法核实：Linux 与 Windows archive 的实际下载、解压、权限/执行行为；执行报告明确说明未在这些主机上运行。diff 已显式区分 `.tar.gz`/`.zip`、`node`/`node.exe`、Unix `chmod` 与 Windows PowerShell 解压，因此这项不计为失败。
- ⚠️无法核实：除报告已实机验证的 Apple ARM64 archive 外，其余硬编码 SHA-256 是否与 Node 官方发行物完全一致；指定审查材料不包含官方 checksum 清单。这项不计为失败。
