# 060 独立审查报告

结论：**APPROVED**

基线：`0fb3afbdf656df7184134075887aa414eb348828`。本轮复核 060 声明 diff 与上一轮阻断修复，只写本 review；未修改产品/测试代码、未 commit、未派生 agent。按任务边界未运行全仓 `pnpm test`，该最终门留给 070。

## 阻断修复复核

- **stale callback 不再污染共享 generation。** `ConversationCapabilitiesPanel.tsx:49-52` 先读取 `inputsRef.current`，并在任何 `++loadGeneration.current` 前核对最新 `open/sessionId/policyVersion`；身份过期的旧 callback 直接返回。生成号建立后，success、error、finally 仍统一经过 generation 与三项身份复查（`:53-72`）。因此 session/policy 切换、retry 覆盖和 close 清理触发的旧请求均不能回写 catalog/error/loading，旧 update 尾部的 `load()` 也不能反向作废最新请求。
- **真实交错回归有效。** `ConversationCapabilitiesPanel.test.tsx:155-174` 使用两个 deferred：先让 toggle pending，再将 policyVersion 从 `one` rerender 到 `two` 并确认新版 catalog load 已启动，随后 resolve toggle 以触发旧 render 的 update 尾部 `load()`，最后 resolve 新 load；直接断言 `Latest tool` 落地、`role=status` 消失且无 alert。单独运行该用例为 `1 passed / 9 skipped`，完整定向门中同样通过。

## 060 其余验收项

- **中文 tombstone 无英文泄漏，动态描述不翻译。** Core 对 unavailable tombstone 返回空 `description`（`sessionCapabilityCatalog.ts:49-65`）；展示层用 Lingui 渲染固定不可用说明，available 项直接渲染原始 `item.description`（`ConversationCapabilitySection.tsx:76-80`）。真实中英文 Provider 回归见 `ConversationCapabilitiesPanel.test.tsx:117-126`；生产实现中检索旧英文 `No longer available in the current environment.` 无命中。
- **loading 与双空态完整。** 首次加载使用 `role=status`（`ConversationCapabilitiesPanel.tsx:175`）；工具和 Skills 独立空态见 `ConversationCapabilitySection.tsx:55-60`，直接测试见 `ConversationCapabilitiesPanel.test.tsx:128-137`。普通旧/新请求乱序覆盖见测试 `:139-153`，stale update 交错见 `:155-174`。
- **键盘与焦点完整。** Tab/Shift+Tab 首尾环绕位于 `ConversationCapabilitiesPanel.tsx:147-166`，Escape 关闭与 trigger 焦点归还位于 `:86-94,148-152`；直接测试 `ConversationCapabilitiesPanel.test.tsx:200-219` 同时覆盖四项。
- **AppShell 原断言未弱化。** 相对基线的 `AppShell.test.tsx` diff 仅在 `:57-65` 增加稳定 capability commands mock；基线已有 7 个测试与全部断言均保留。该文件包含在定向 20 tests 全绿结果中。
- **Lingui 稳定。** `pnpm lingui:extract` 报 zh-CN 509、en 509 / Missing 0，`pnpm lingui:compile` 通过；运行前后四个 catalog SHA-1 完全一致：en PO `662a0d...`、en JS `84e6e5...`、zh-CN PO `60e738...`、zh-CN JS `5d7362...`。
- **行数与职责符合硬门。** `wc -l`：catalog 115、catalog test 129、Panel 208、Section 94、Panel test 236、AppShell test 273；所有非 i18n 声明文件均 ≤300，仍各自保持 catalog、panel 编排、section 渲染或对应测试的单一职责。i18n catalog 属规则豁免。

## 机械门

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx -t '旧 toggle 尾部的 stale load 不会作废 policy 更新后的当前 load'` | PASS：1 passed、9 skipped |
| `pnpm exec vitest run packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx apps/web/src/agentNew/ui/AppShell.test.tsx` | PASS：3 files、20 tests |
| `pnpm exec tsc -b --pretty false` | PASS |
| `pnpm lingui:extract` / `pnpm lingui:compile` | PASS；509/509、English Missing 0、前后 hash 一致 |
| `git diff --check` | PASS |

上一轮 generation/loading 阻断已关闭；060 可以交给 070 做冻结工作区后的全仓终验。
