# 110 设置国际化回归独立审查：PASS

## 结论

`apps/web/src/agentNew/ui/i18nSettings.test.tsx` 满足任务 110 的验收要求：文件 271 行、职责仅为设置界面真实 catalog 的中英文回归；中文默认与显式 English 均覆盖设置导航、模型、MCP、插件及 Project Skills 多个表面。测试使用真实 `AppI18nProvider`、`activateLocale` 和 compiled PO catalog，未 mock i18n provider/runtime、macro 或 catalog。动态 credential、URL、server/plugin/skill 名称及 plugin/skill diagnostics 均有原文断言。未发现需要修复的问题。

## 关键证据

- 真实 i18n 链：测试第 10、231 行直接调用生产 `activateLocale('en')`；`renderWithStore.tsx:35-38,50-58` 按当前 `appI18n.locale` 水合 store 并挂载真实 `AppI18nProvider`；`activateLocale.ts:8-12` 动态导入 `en/messages.po` / `zh-CN/messages.po`，由仓库 Lingui Vite plugin 编译。目标测试无 `vi.mock` / `vi.doMock`；唯一 `vi.stubEnv` 只固定图片能力开关。
- 中文默认覆盖：第 214-227 行断言中文 locale/lang、设置入口、模型 heading/credential placeholder/action、MCP form/action/server status/launch action、plugin status/diagnostic count 与 Project Skills heading/count。
- English 多表面覆盖：第 234-269 行断言 English locale/lang、设置入口和模型导航/表单/动作、MCP form/server/launch 动作、plugin 状态/tool count/diagnostic、Project Skills heading/action/count/scan/resource 文案。
- 动态原文边界：credential 在第 239 行以 `toHaveValue(CREDENTIAL)` 精确断言；URL 第 242 行；server name 第 248、251 行；plugin name 第 255 行；plugin diagnostic 第 259 行；skill name/description/diagnostic 第 266-268 行，均与 English 固定框架在同一真实 locale 用例中验证。命令和工具名亦在第 250、260 行保持 fixture 原文。
- English 不被中文覆盖：第 231 行先完成 `activateLocale('en')`，随后 `renderWithStore` 从已激活 locale 水合 `localePreferenceAtom`；第 234-235 行的 `en` locale/lang 断言及全部 English 文案实际通过。
- 隔离完整：第 179-194 行每例保存原 `appI18n.locale`、locale localStorage 值和 HTML lang；第 196-211 行先卸载 UI、重置设置状态，再精确恢复原 locale、localStorage（含原先不存在的情形）及 HTML lang。全局 setup 另在每例后重置 root store 并执行 `vi.unstubAllEnvs()`。
- 单一职责与范围：测试内 helper 只构造模型/MCP/plugin/skill fixture 与统一渲染，两条用例只验证设置 i18n；271 行低于普通文件 300 行硬上限。scoped status 仅显示该新增测试及任务报告为 untracked；110 未产生产品、PO、compiled catalog、generated 或任务定义 diff。

## 独立命令

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nSettings.test.tsx`
   - PASS，exit 0；1 file / 2 tests。
2. `pnpm exec tsc -b --pretty false`
   - PASS，exit 0；无诊断。
3. `git diff --check -- apps/web/src/agentNew/ui/i18nSettings.test.tsx`
   - PASS，exit 0、无输出。文件为 untracked，另执行 `git diff --no-index --check -- /dev/null apps/web/src/agentNew/ui/i18nSettings.test.tsx`，无 whitespace diagnostics；exit 1 仅表示存在新增 diff。
4. `wc -l apps/web/src/agentNew/ui/i18nSettings.test.tsx`
   - `271`，满足 ≤300。
5. `git rev-parse HEAD`
   - `c7befb48ea8c38a91d10c58097cb1206fbef8cc1`，与任务基线一致。

## R1

无；不需要返修。

本次审查未修改产品、测试、PO、compiled catalog、generated、任务定义、index 或执行报告；唯一写入为本审查报告。
