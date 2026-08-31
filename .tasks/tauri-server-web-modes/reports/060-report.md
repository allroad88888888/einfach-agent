# 060 Desktop 发布矩阵执行报告

状态：DONE

## 修改范围

- `.github/workflows/release-desktop.yml`
  - 新建只含 `macos-14` 与 `aarch64-apple-darwin` 的单目标 matrix。
  - PR、分支 push 与手动触发只走无 secrets 的验证构建。
  - 所有构建先依次构建共享 runtime、Node host runtime、暂存与 matrix target 对应的 Node sidecar，并在打包前运行 `node scripts/check-desktop-wrapper.mjs`。
  - `app-v*` tag 路径先校验 tag 等于 `app-v<apps/desktop/tauri.conf.json.version>`，再只检查签名/notarization secrets 是否非空；不会打印 secret 值。满足后才将 secrets 传给显式使用 matrix target 的 Tauri build。
  - 未加入 GitHub release、push 或 artifact upload 步骤。
- `docs/desktop-release.md`
  - 说明 Apple Silicon 唯一发布矩阵、验证与 tag 路径、版本标签格式及所需 GitHub Actions secrets。

## 静态验证

```text
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/release-desktop.yml'); puts 'workflow YAML parses'"
```

通过：`workflow YAML parses`。

```text
rg -n "aarch64-apple-darwin|stage-desktop-node-runtime|check-desktop-wrapper|app-v|APPLE_(CERTIFICATE|CERTIFICATE_PASSWORD|SIGNING_IDENTITY|ID|PASSWORD|TEAM_ID)" .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过：确认唯一 target、target 对应 staging、wrapper 前置检查、tag/version 门禁及六个 signing/notarization secret 的使用和文档均存在。

```text
! rg -n "upload-artifact|action-gh-release|gh release|git push" .github/workflows/release-desktop.yml
```

通过：workflow 不含 artifact 上传、GitHub release 或 push 操作。

```text
git diff --check -- .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过（无输出）。

```text
wc -l .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过：workflow 78 行，文档 26 行，均低于 300 行。

## 安全边界

本执行只创建本地 workflow 与文档；没有运行任何发布、push、artifact upload 或实际签名/notarization，也没有读取真实 secrets。正式 tag 的 secrets 仅在未来 GitHub Actions 运行时按步骤注入，检查日志只会报告缺失的变量名。

## Diff 边界

产品/文档 diff 仅包含：

- `.github/workflows/release-desktop.yml`
- `docs/desktop-release.md`

本执行额外回写本报告：`.tasks/tauri-server-web-modes/reports/060-report.md`。

## R1 修复与验证

- 将 `pnpm/action-setup@v4` 移至带 `cache: pnpm` 的 `actions/setup-node@v4` 之前，避免干净 runner 在 pnpm 可执行文件可用前初始化 pnpm cache。
- verification 和 signed packaging 两条路径都改为直接执行：

  ```text
  pnpm exec tauri build --config apps/desktop/tauri.conf.json --target ${{ matrix.target }}
  ```

  这避免了向已硬编码 target 的 `desktop:build` package script 再转发 `--target`，同时让 Tauri packaging 与 sidecar staging 显式消费同一 matrix target。
- 发布文档已说明 packaging 显式使用同一 `${{ matrix.target }}`。

R1 验证命令：

```text
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/release-desktop.yml'); puts 'workflow YAML parses'"
```

通过：`workflow YAML parses`。

```text
rg -F -n 'pnpm exec tauri build --config apps/desktop/tauri.conf.json --target ${{ matrix.target }}' .github/workflows/release-desktop.yml docs/desktop-release.md
rg -F --count 'pnpm exec tauri build --config apps/desktop/tauri.conf.json --target ${{ matrix.target }}' .github/workflows/release-desktop.yml
```

通过：workflow 两条 packaging 路径均出现该命令（计数为 2），文档也出现相同命令。另已静态确认 `pnpm/action-setup` 位于 `actions/setup-node` 前，workflow 不含 artifact upload、GitHub release 或 push。

```text
git diff --check -- .github/workflows/release-desktop.yml docs/desktop-release.md
wc -l .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过：diff 检查无输出；workflow 78 行，文档 26 行，均低于 300 行。

## R2 修复与验证

- 在依赖安装与所有构建步骤之前加入 `rustup target add ${{ matrix.target }}`，使 Tauri packaging 不依赖 runner 预装的 Rust target。
- 文档明确 CI 安装同一 Rust matrix target；Rust 编译、Node sidecar staging 与两条 Tauri packaging 路径均消费 `${{ matrix.target }}`。

R2 验证命令：

```text
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/release-desktop.yml'); puts 'workflow YAML parses'"
```

通过：`workflow YAML parses`。

```text
rg -F -n 'rustup target add ${{ matrix.target }}' .github/workflows/release-desktop.yml docs/desktop-release.md
rg -F -n 'pnpm exec tauri build --config apps/desktop/tauri.conf.json --target ${{ matrix.target }}' .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过：workflow 在依赖安装前安装 Rust target，两个显式 matrix-target packaging 命令均存在，文档描述相同 target 的安装、staging 与 packaging。另确认 pnpm setup 仍位于 cached setup-node 前，且 workflow 不含 release、push 或 artifact upload。

```text
git diff --check -- .github/workflows/release-desktop.yml docs/desktop-release.md
wc -l .github/workflows/release-desktop.yml docs/desktop-release.md
```

通过：diff 检查无输出；workflow 81 行，文档 26 行，均低于 300 行。
