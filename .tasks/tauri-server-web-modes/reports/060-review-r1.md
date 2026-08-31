# 060 R1 独立复审

结论：**REJECTED**

本轮仅读取任务、初审、R1 执行报告、workflow/文档及相对 base 的完整新增内容。按要求未重跑报告中的验收命令。

## 初审 Important 逐条复核

1. ✅ **pnpm/setup-node 顺序已修复。** `.github/workflows/release-desktop.yml:24-31` 现在先用 `pnpm/action-setup@v4` 安装 pnpm，再运行带 `cache: pnpm` 的 `actions/setup-node@v4`，干净 runner 不再需依赖预装 pnpm 来初始化 cache。

2. ❌ **staging/build 虽已共用 matrix target，但 target 编译前置仍不完整。** `:43` 的 staging 与 `:67,78` 的两条 Tauri packaging 现在都显式消费 `${{ matrix.target }}`，修复了“build 隐式使用 host target”的原问题。但 workflow 从未执行 `rustup target add ${{ matrix.target }}`，也没有任何 Rust toolchain/target setup step，却直接强制 `tauri build --target aarch64-apple-darwin`。当 runner 的默认 Rust host target 不是 aarch64 时，编译会在 packaging 前失败；workflow 不能把未声明、未校验的 runner 预装 target 当作发布前置。初审的可执行修复也已明确要求“在需要交叉编译时先安装该 Rust target”，R1 未处理这一部分。

## 其他边界

- ✅ PR、分支 push 和手动路径仍不注入 release secrets，且 workflow 无 upload、release、push 或 publish 步骤。
- ✅ tag-only prerequisite 仍精确校验 `app-v<tauri.conf.json.version>` 与六个 Apple secret 非空，日志只输出期望 tag 或缺失的变量名，不输出 secret 值。
- ✅ 步骤顺序为 checkout、pnpm/Node setup、install、runtime build/staging、wrapper check、tag prerequisite、packaging；除 Rust target 前置外，未发现新的顺序或 secret 边界退化。
- ✅ workflow 78 行、文档 26 行，均不超过 300 行，且各自保持 desktop release 自动化与发布契约说明的单一职责。

## Findings

### Critical

无。

### Important

1. **显式 aarch64 Tauri build 缺少对应 Rust target 安装。** 在 packaging 之前增加可执行的 toolchain step，至少执行 `rustup target add ${{ matrix.target }}`；或改用能明确保证 host target 就是 matrix target 的 runner，并在 workflow 中加入显式校验，不要依赖未声明的预装状态。

### Minor

无。

## 最终判定

**REJECTED**。初审 Important 1 已关闭；Important 2 的 matrix target 传递已修复，但交叉编译前置仍缺失，workflow 尚不具备可靠的实际运行条件。
