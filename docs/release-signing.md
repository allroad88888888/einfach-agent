# Desktop 发布与签名

桌面版发布由 [release-desktop.yml](../.github/workflows/release-desktop.yml) 执行。只有推送与
`apps/desktop/tauri.conf.json` 版本一致的 `app-v<version>` tag 才会启动，例如当前版本的
`app-v0.1.0`。发布流程会先校验所有签名 Secret，再构建 Linux x64、Windows x64、macOS
Apple Silicon 和 macOS Intel 产物。

所有产物上传到同一个 GitHub Draft Release。流水线不会自动发布 Draft；发布负责人必须在
GitHub 复核产物、签名和 release notes 后手动发布。

## 所需 Repository Secrets

| Secret | 用途 |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 编码的 Developer ID Application `.p12` 证书。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_SIGNING_IDENTITY` | macOS `security find-identity -v -p codesigning` 显示的 Developer ID identity。 |
| `APPLE_ID` | 用于 notarization 的 Apple ID 邮箱。 |
| `APPLE_PASSWORD` | 对应 Apple ID 的 app-specific password。 |
| `APPLE_TEAM_ID` | Apple Developer Team ID。 |
| `KEYCHAIN_PASSWORD` | CI 临时 macOS keychain 的随机密码。 |
| `WINDOWS_CERTIFICATE` | Base64 编码的 Windows code-signing `.pfx` 文件。 |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` 导出密码。 |

Secret 缺失或 tag 与 Tauri 版本不一致时，工作流会在创建任何发布产物前失败。证书只在对应
runner 的临时 keychain 或用户证书存储中导入，步骤结束后删除临时文件。

## 发布步骤

1. 更新 `package.json` 和 `apps/desktop/tauri.conf.json` 的版本，并先通过 CI。
2. 在待发布提交创建并推送 `app-v<version>` tag。
3. 等待 `Release desktop` 的四个原生构建完成，并在 Draft Release 检查所有安装包。
4. 确认 macOS notarization 和 Windows 签名有效后，手动发布 Draft Release。

Linux 安装包由原生 Linux runner 可复现构建；Windows 与 macOS 由各自平台的系统证书工具
签名。不要把任何证书、密码或模型凭证写入仓库、Tauri 配置或构建环境文件。
