# 060 独立审查

结论：**REJECTED**

本审查仅读取任务、执行报告、workflow、发布文档及其相对 base 的新增内容。按要求未重跑报告中的验收命令。

PR、分支 push 和手动路径的 secret/publish 边界清晰：tag 路径也会在注入签名环境的 build 前校验 tag/version 与六个 Apple 前置变量，检查时只打印缺失的变量名。但 workflow 存在两个会阻断实际运行或破坏 target 一致性的步骤问题。

## 验收判定

1. ❌ YAML 据报告可静态解析，matrix 中唯一 target 与 staging 命令均为 `aarch64-apple-darwin`；但 packaging build 未消费 `matrix.target`，且 pnpm cache 的 action 顺序在干净 runner 上不可靠，因此“可实际运行”与 staging/build target 一致性未成立。
2. ✅ PR 与所有非 `app-v*` ref 只运行 verification build。Secrets 仅出现在两个 tag-only step 的 step-level `env`；workflow 没有 upload-artifact、release、push 或 publish 步骤，`contents: read` 也限制了 token 写权限。
3. ✅ tag 检查要求 `github.ref_name` 精确等于 `app-v<tauri.conf.json.version>`，并在签名 build 前检查 certificate、password、identity 与 notarization 凭据非空。Shell 未 echo 任何 secret 值，文档也只列出 secret 名。
4. ✅ workflow 78 行、文档 26 行，均不超过 300 行；两者分别承担 desktop release 自动化与运维契约说明，单一职责成立。

## Findings

### Critical

无。

### Important

1. **pnpm cache 在 pnpm 安装前初始化，干净 runner 可在 install 前失败。** `.github/workflows/release-desktop.yml:24-31` 先执行带 `cache: pnpm` 的 `actions/setup-node@v4`，后执行 `pnpm/action-setup@v4`。setup-node 初始化 pnpm cache 时需要可执行的 pnpm 以获取 store path；workflow 不应依赖 runner 预装 pnpm。**可执行修复：**将 `pnpm/action-setup@v4` 移到 `actions/setup-node@v4` 之前，保留后者的 `cache: pnpm`，然后再运行 `pnpm install --frozen-lockfile`。

2. **matrix target 只传给 staging，没有传给 Tauri build。** `:20,43` 将 Node sidecar 暂存为 `aarch64-apple-darwin`，但 `:67,78` 两条 packaging 路径都只运行 `pnpm desktop:build`，没有将 `${{ matrix.target }}` 传入 build。这使得产物 target 隐式取决于 runner host/default config，matrix 不再是 staging 与 packaging 的共同单一事实源；在 host target 不同时还会把 aarch64 sidecar 与其他架构 bundle 组合。**可执行修复：**让 verification 和 signed build 均显式执行等价于 `pnpm desktop:build -- --target ${{ matrix.target }}` 的命令（以项目脚本的实际参数转发方式为准），并在需要交叉编译时先安装该 Rust target。文档也应说明 build 显式消费同一 matrix target。

### Minor

无。

## 最终判定

**REJECTED**。先修正 pnpm/setup-node 顺序，再使 staging 与两条 packaging build 显式消费同一 matrix target。
