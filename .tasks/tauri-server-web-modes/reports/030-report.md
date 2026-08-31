# 030 暂存 Node runtime：执行报告

## 改动摘要

- 新增 `scripts/stage-desktop-node-runtime.mjs`：固定下载 Node `22.13.0`，按受支持的 Tauri target 映射官方 macOS/Linux `.tar.gz` 或 Windows `.zip`，以硬编码 SHA-256 校验缓存，然后暂存为 `apps/desktop/binaries/einfach-agent-node-<target>[.exe]`。
- 新增 stager 测试，覆盖 target 映射、缺失 archive、SHA-256 不匹配和输出文件命名。
- 新增 `apps/desktop/.gitignore` 和 `binaries/.gitkeep`，使 runtime 与下载缓存不进入 Git；新增使用说明 `docs/desktop-node-runtime.md`。
- 当前 Apple Silicon 主机已实际暂存 `aarch64-apple-darwin` runtime。`apps/desktop/binaries/` 仅含 `.gitkeep` 与被忽略的 sidecar。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `node scripts/stage-desktop-node-runtime.test.mjs` | 通过：`stage-desktop-node-runtime tests passed`。 |
| `node scripts/stage-desktop-node-runtime.mjs --target aarch64-apple-darwin` | 通过：写入 `apps/desktop/binaries/einfach-agent-node-aarch64-apple-darwin`。 |
| `test -x apps/desktop/binaries/einfach-agent-node-aarch64-apple-darwin && apps/desktop/binaries/einfach-agent-node-aarch64-apple-darwin --version` | 通过：文件可执行，输出 `v22.13.0`，满足 `>=22.13.0`。 |
| `find apps/desktop/binaries -maxdepth 1 -type f -print \| sort` | 通过：仅 `.gitkeep` 与 `einfach-agent-node-aarch64-apple-darwin`。 |
| `git status --short --untracked-files=all -- apps/desktop` | 通过：仅显示将提交的 `.gitignore`、`.gitkeep`；未显示 sidecar 或缓存。 |
| `git check-ignore -v apps/desktop/binaries/einfach-agent-node-aarch64-apple-darwin apps/desktop/.cache/node-runtime/node-v22.13.0-darwin-arm64.tar.gz` | 通过：分别由 `binaries/*`、`.cache/` 忽略。 |
| `wc -l ...`（本任务新增文件） | 通过：脚本 164 行、测试 42 行、文档 29 行，均低于 300 行。 |
| `git diff --check -- apps/desktop/.gitignore apps/desktop/binaries/.gitkeep scripts/stage-desktop-node-runtime.mjs scripts/stage-desktop-node-runtime.test.mjs docs/desktop-node-runtime.md` | 通过：无 whitespace error。 |

## 未验证项

- 未在 Linux 或 Windows 主机实际下载、解压和运行对应 runtime；脚本已分别实现 tar 与 Windows PowerShell zip 路径。
- 未运行任务范围外的 `pnpm build`、Tauri bundle 或完整测试套件。

## 范围外发现

- 工作区原本已有大量用户在途改动；未读取、修改、暂存或覆盖这些改动。
- 任务索引已记录：全量 `pnpm test` 当前会受用户删除的 `apps/web/src/agentNew/ui/UndoBar.tsx` 对应 invariant 测试阻塞；本任务未处理。

## 疑虑

- 官方 Node `22.13.0` 提供的 Linux archive 是 glibc 构建，因此 stager 只接受 Linux GNU target，明确拒绝 musl target，避免生成无法运行的错误 sidecar。

## 建议后续动作

- 040 应在 `tauri.conf.json` 以 `bundle.externalBin: ["binaries/einfach-agent-node"]` 消费该命名，并在桌面构建前调用 stager。
- 为后续发布目标的原生 CI 增加一次实际 staging 与 `--version` smoke test。
