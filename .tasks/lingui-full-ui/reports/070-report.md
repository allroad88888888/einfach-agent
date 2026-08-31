# 070 模型设置面报告

## 完成范围

- 仅迁移任务列出的六个模型设置产品文件中的静态可见文本、`aria-label`、placeholder 和固定插值框架到 Lingui v6 `@lingui/react/macro` 的 `Trans` / `useLingui().t`。
- Provider 名、凭据标签、用户输入的 Key、已登记 endpoint URL、服务端错误和 Kimi 会话标题仍按原数据路径渲染；未修改 atom、命令、credential/endpoint host 或网络行为。
- 未修改 `ModelConnectionProfile*`、测试、PO/catalog，也未运行 extract/compile。

## 验证

- `pnpm exec vitest run apps/web/src/agentNew/ui/SettingsCenter.test.tsx apps/web/src/agentNew/ui/StartupCredentialGate.test.tsx`：通过，12 tests。
- `git diff --check -- <六个任务文件>`：通过。
- 行数（均低于 300）：SettingsCenter 41；StartupCredentialGate 138；ModelCredentialPanel 146；ModelCredentialCard 92；ModelCredentialGroups 67；ModelEndpointCard 86。

## 范围外阻塞

`pnpm exec tsc -b` 未通过，错误均在用户在途的 ModelConnection 测试，未触碰：

- `apps/web/src/settings/modelConnectionProfileCommands.test.ts(90,75)`：`"manual"` 不能赋给 `"discovered"`。
- `apps/web/src/settings/settingsCenterCommands.test.ts(24,40)`：`ModelConnectionProfile` 缺少必填 `models`。
- `apps/web/src/settings/settingsCenterCommands.test.ts(31,5)`：`ModelConnectionProfileDraft` 不识别 `model`，提示应使用 `models`。
