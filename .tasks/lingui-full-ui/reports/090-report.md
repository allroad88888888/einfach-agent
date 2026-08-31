# 090 插件与技能设置面国际化报告

- 仅修改了 `PluginSettingsPanel.tsx`、`PluginEntryCard.tsx`、`PluginToolToggleList.tsx` 与 `ProjectSkillsPanel.tsx`；固定警告、空态、动作、状态、计数插值、`aria-label` 和 `title` 已迁移到 Lingui v6 `Trans`/`useLingui().t`。
- 插件名称、描述、诊断、skill 名称、来源路径和资源文件名仍按数据原样渲染；未改动插件加载、skill 扫描或 Einfach toggle store。
- `pnpm exec vitest run apps/web/src/agentNew/ui/PluginSettingsPanel.test.tsx apps/web/src/agentNew/ui/ProjectSkillsPanel.test.tsx`：通过（2 files，11 tests）。
- `pnpm exec tsc -b`：被任务外在途 Model Connection 测试类型错误阻断；报错仅涉及 `ModelConnectionProfileEditor.test.tsx`、`ModelConnectionProfilesPanel.test.tsx`、`ModelCredentialPanel.connections.test.tsx`、`modelConnectionProfileCommands.test.ts` 和 `settingsCenterCommands.test.ts`，不涉及本叶四个文件。
- `git diff --check -- <four source files>`：通过。
- 行数：83、84、55、233；全部低于 300 行上限。
