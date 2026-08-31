# 桌面发布与签名

当前桌面端是只承载 Node sidecar 的 Apple Silicon Tauri 薄壳，而不是旧的富 Rust 业务宿主。当前
`release-desktop.yml` 在 pull request、非 tag push 与手动触发时只验证构建；`app-v<version>` tag 则先核对
版本，再执行可签名、可 notarization 的 Apple Silicon 构建。当前 workflow 不上传 artifact、不创建 GitHub
Release、不发布，也不 push；这些仍须另行授权。

## 当前 Apple Silicon 路径

唯一 target 为 `aarch64-apple-darwin`。每个 CI job 安装相同 Rust target、构建共享 server/Node runtime、
暂存对应 Node sidecar，并在打包前运行桌面 wrapper 检查。tag 必须精确等于
`app-v<apps/desktop/tauri.conf.json.version>`。

签名与 notarization 的 tag job 只检查以下 GitHub Actions secrets 是否非空，不会输出其值：

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书。 |
| `APPLE_CERTIFICATE_PASSWORD` | 证书导出密码。 |
| `APPLE_SIGNING_IDENTITY` | Developer ID codesigning identity。 |
| `APPLE_ID` | notarization Apple ID。 |
| `APPLE_PASSWORD` | Apple ID app-specific password。 |
| `APPLE_TEAM_ID` | Apple Developer Team ID。 |

这些凭据仅注入 tag 的前置检查及 Tauri build 步骤；PR 与非 tag 路径不接收它们。完整的运行矩阵见
[桌面发布矩阵](desktop-release.md)。

## 历史：已删除的四平台 Rust 宿主流程

`e52c31d` 删除了旧的富 Rust 业务宿主及其自动 GitHub Draft Release 流程。那条历史流水线构建 Linux
x64、Windows x64、macOS Apple Silicon 和 macOS Intel，使用下列九个 secrets，并上传到 Draft Release。
它不是当前操作步骤；保留这份账本只为说明曾经的发布成本。

| 历史 Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application `.p12` 证书。 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码。 |
| `APPLE_SIGNING_IDENTITY` | macOS Developer ID identity。 |
| `APPLE_ID` | notarization Apple ID。 |
| `APPLE_PASSWORD` | Apple ID app-specific password。 |
| `APPLE_TEAM_ID` | Apple Developer Team ID。 |
| `KEYCHAIN_PASSWORD` | CI 临时 macOS keychain 密码。 |
| `WINDOWS_CERTIFICATE` | Windows code-signing `.pfx`。 |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` 导出密码。 |
