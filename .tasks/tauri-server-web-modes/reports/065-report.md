# 065 桌面发布文档对齐报告

状态：DONE

## 已完成的范围内修改

- `docs/release-signing.md`
  - 说明当前为仅承载 Node sidecar 的 Apple Silicon Tauri 薄壳。
  - 写明 PR/非 tag 仅验证构建，`app-v<version>` tag 可做签名/notarization build，且 workflow 不 upload、publish、push 或创建 GitHub Release。
  - 列出当前六个 Apple secrets；将旧四平台富 Rust 宿主、九个 secrets 与自动 Draft Release 明确标为 `e52c31d` 删除的历史流程。
- `docs/launch/repo-metadata.md`
  - 不再声称桌面 workflow 当前不存在；保持 GitHub Releases 当前没有产物的准确说明。
- `docs/ROADMAP.md`
  - 将已删除的旧多平台 Rust 宿主流程与当前 Apple Silicon Node-sidecar 薄壳 CI 路径分开记录，未将新实现标作已作废。

## 验证

```text
rg -n "aarch64-apple-darwin|Node sidecar|不上传 artifact|不创建 GitHub Release|不发布|不 push|app-v<version>|KEYCHAIN_PASSWORD|WINDOWS_CERTIFICATE|Draft Release" docs/release-signing.md docs/launch/repo-metadata.md docs/ROADMAP.md
```

通过：当前薄壳/Apple Silicon/无发布边界、六-secret 路径与九-secret 四平台历史账本均有明确证据。

```text
git diff --check -- docs/release-signing.md docs/launch/repo-metadata.md docs/ROADMAP.md
wc -l docs/release-signing.md docs/launch/repo-metadata.md docs/ROADMAP.md
```

通过：diff 检查无输出；三份文件分别为 44、119、110 行，均低于 300 行。

## 最终文档门禁

```text
node scripts/check-docs.js
```

首次运行被两份任务外审查报告的损坏相对链接阻断；编排者已在 `.tasks` 账本内完成最小修复。本执行未改 task/index/review，随后重跑：

```text
node scripts/check-docs.js
```

通过：`Documentation check passed (317 Markdown files).`

因此所有 065 验收均已通过。
