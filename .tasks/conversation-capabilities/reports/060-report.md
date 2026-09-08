# 060 UI 与国际化收口报告

结论：**DONE（复核竞态已修复）**

基线：`0fb3afbdf656df7184134075887aa414eb348828`。未 commit、未改写 stash；产品与测试改动均限于 060 声明文件。

## 收口内容

- Core catalog 的 locked tombstone 现在仅保留稳定结构，`description` 为 `''`；UI 对 `available=false` 通过 Lingui 显示“此能力在当前环境中已不可用。”，正常动态描述仍直出。
- Panel 的 load 以单调 request generation 加上 `open/sessionId/policyVersion` 身份守卫；在递增 generation 前先预检 callback 捕获身份，旧 update 尾部的 stale load 不能作废当前请求。旧请求在切换 policy、会话或关闭后的成功、失败、finally 均不能写回 catalog、error 或 loading。
- 直接增加首次 `role=status`、工具/Skills 双空态、延迟 promise 乱序、真实 toggle 推进 policy 后旧尾部 load 的 generation 回归、真实 i18n Provider 的中英 tombstone、Tab/Shift+Tab 焦点环绕测试；保留 Escape 关闭及触发按钮焦点归还断言。
- AppShell 的 runtime commands mock 补齐稳定 catalog 与 capability command 形状，原有 5 项组装断言未删减。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx apps/web/src/agentNew/ui/AppShell.test.tsx` | PASS：3 files、20 tests |
| `pnpm exec tsc -b --pretty false` | PASS |
| `pnpm lingui:extract` | PASS：en 509 total、Missing 0 |
| `pnpm lingui:compile` | PASS |
| `git diff --check` | PASS |

全仓 `pnpm test` 在 050 并行改动期间运行，早期输出出现非 060 文件的 host-node rollout 与 SettingsCenter MCP 失败；不以该并行中间态替代最终冻结后的全仓验收，070 应复跑。

## 行数与职责

非 i18n 文件均小于 300 行：catalog 115、catalog test 129、Panel 208、Section 94、Panel test 236、AppShell test 273。每个文件保持既有单一职责；新增测试仍集中于 capability panel 交互。
