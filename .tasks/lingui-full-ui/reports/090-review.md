# 090 独立审查：PASS

## 结论

基于基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 的范围 diff 只包含任务指定的四个源文件。
固定警告、空态、action、state、count 插值、`aria-label` 与 `title` 均使用 Lingui v6
`@lingui/react/macro` 的 `Trans` 或 `useLingui().t`；插值没有被静态翻译替代。未发现遗漏文案或行为回归。

## 核验证据

- `PluginSettingsPanel.tsx:36-77` 的标题、信任警告、不支持/加载/无插件空态全部使用
  `Trans`；`hydration.error` 在第 65 行仍原样渲染。
- `PluginEntryCard.tsx:27-41,74-77` 的状态、动作、插件 `aria-label` 和诊断数量均用 `t`；
  插件名/dir name/id/version 在第 12-13、45、52-53 行直接来自 `row`，诊断原文在第 76-77 行直接渲染。
- `PluginToolToggleList.tsx:29-30` 的固定提示与两个 count 插值使用 `Trans`；工具名在第 34、43、47 行仍为
  `tool.name` 原文。
- `ProjectSkillsPanel.tsx:62,71,74,81,91,143-144,159-223` 覆盖固定动作、状态、数量、空态、
  `aria-label` 及来源 `title`；skill name/description、来源路径、workspace 路径、诊断及错误分别在
  第 69、74-75、81、89、115、172-173、190、197、217、224-225 行作为动态值原样传入或渲染。
- 行为对比：插件加载仍由 `hydratePluginSettings()` effect 触发；插件启停、工具 toggle、skill 刷新与启停
  仍调用原 `disablePlugin`/`enablePlugin`/`setPluginToolEnabled`/
  `refreshProjectSkillsFromSettings`/`updateProjectSkillEnabled`，且 busy/locked/enabled 条件未改。
- 四个文件分别只负责插件面板、单个插件卡、单个插件的工具可见性列表、项目 skill 设置面；
  `wc -l` 为 `83 / 84 / 55 / 233`，全部低于 300 行。

## 独立命令结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/PluginSettingsPanel.test.tsx apps/web/src/agentNew/ui/ProjectSkillsPanel.test.tsx`
   - exit 0；2 files passed，11/11 tests passed。
2. `pnpm exec tsc -b`
   - exit 2；当前仅有 3 个错误：`modelConnectionProfileCommands.test.ts:90` 的
     `manual`/`discovered` 字面量不兼容，以及 `settingsCenterCommands.test.ts:24,31` 的旧
     `model`/新 `models` 契约漂移。两个文件属正在进行的 Model Connection 任务树，不在 090 四文件范围；
     输出不含本叶文件。这是任务外基线阻塞，不改变 PASS 结论。
3. `git diff --check c7befb48ea8c38a91d10c58097cb1206fbef8cc1 -- <four source files>`
   - exit 0，无输出；`git diff --name-only` 在该范围精确列出四个任务文件。
4. `wc -l <four source files>`
   - `83` / `84` / `55` / `233`。

## R1

无。不需要返修。

## 范围确认

审查未修改产品、测试、PO/catalog、任务定义或其他报告；仅写本审查报告。
