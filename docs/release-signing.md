# 桌面发布与签名（历史记录，已无实现）

> **本文描述的东西已经不存在了。** 桌面端（`apps/desktop/`）与它的发布流水线
> `release-desktop.yml` 已随 [Node 宿主树](node-host-issues.md) 的 T1 一并删除，仓库里今天没有
> 任何一处消费下面这九个 Secret，也没有任何 tag 会触发桌面构建。
>
> **保留本文不是为了留操作步骤，而是为了留代价。** 下面这张表是「为什么不做桌面版」这个决定的
> 全部依据：发一个原生窗口要 Apple Developer ID 与 Windows code-signing 两套证书，而绕开这条链路
> 正是把宿主改成「浏览器 + 本机 Node 后端」的**唯一动机**（见 Node 宿主树的「目标」段）。
> 删掉这张表，「不如干脆做个桌面版」这个念头就会被后人重新想一遍，而重新想的人不会再看到这九行。
>
> 今天的发布口径与本文无关：用户已裁决**不发布、仅本地跑**，四个包保持 `private: true`，
> `release-npm.yml` 只由 `npm-v*` tag 触发且处于休眠；它**一个签名 Secret 都不用**。

## 当时的九个 Repository Secrets

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

七条给 macOS（签名 + 公证两件事，各要一套凭据），两条给 Windows。**它们全部是「向平台证明这个
二进制是谁做的」**，与「有没有权限往某个 registry 写」不是一回事——后者只要一个 token，前者要
向 Apple 与证书颁发机构分别付费并维持有效期。

## 当时的流程（供理解那张表的语境）

桌面发布只由推送 `app-v<version>` tag 触发，且 tag 必须与 `apps/desktop/tauri.conf.json` 的版本
一致。流水线先校验九个 Secret 全部存在，再构建 Linux x64、Windows x64、macOS Apple Silicon 与
macOS Intel 四份产物，上传到同一个 GitHub Draft Release；Draft 不自动发布，由发布负责人复核产物、
签名与 release notes 之后手动发。Secret 缺失或 tag 与版本不一致时，工作流在产出任何安装包之前
就失败。

真正的实现细节（工作流 YAML、证书导入与清理步骤、四平台矩阵）不在本文重述——它们随
`release-desktop.yml` 一起留在 Git 历史里，删除提交是 `e52c31d`。
