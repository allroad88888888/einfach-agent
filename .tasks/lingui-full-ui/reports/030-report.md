# 030 消息输入面报告

## 改动摘要

- 在 `Composer.tsx` 迁移发送、停止、授权模式、排队状态、错误外壳、输入框 aria 标签与 401 提示；动态错误详情继续原样显示。
- 在 `ComposerAttachmentTray.tsx` 迁移图片附件的按钮、状态、title、aria 标签与不支持提示；文件名、能力原因与附件错误继续原样显示。
- 在 `HistoryImageCompatibilityGuard.tsx` 和 `UserImageAttachmentCard.tsx` 迁移历史图片兼容性提示、占位输入框与图片卡片固定框架；图片元数据继续原样显示。
- 全部使用项目既有的 `useLingui()` / `t` 宏写法，未编辑 PO、未运行 Lingui extract/compile。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx`
   - 失败：2 个测试文件、29 个用例均在 `useLingui()` 处失败，原因是 `renderWithStore` 未包裹 `AppI18nProvider`。这是将目标组件接入 Lingui 后暴露的测试装配缺口；测试文件不在本任务 `files` 边界内，未修改。
2. `pnpm exec tsc -b`
   - 失败：报错均在任务范围外的 ModelConnection profile 类型不一致（`model` 与 `models` 字段），涉及 `ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx` 与 `apps/web/src/settings/**`；四个目标文件未出现在错误中。
3. `git diff --check -- apps/web/src/agentNew/ui/Composer.tsx apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx`
   - 通过，无输出、退出码 0。
4. `wc -l` 目标文件
   - 通过：`Composer.tsx` 297 行；其余分别为 82、41、38 行，均不超过 300 行。

## 未验证项

- English 实际渲染未验证：本任务不得写 PO 或运行 extract/compile，需由 050 catalog 任务生成并翻译 catalog 后验证。
- 组件行为回归未能在当前指定测试中完成，待测试 wrapper 注入真实 `AppI18nProvider` 并激活/恢复 locale 后复跑。

## 范围外发现

- `apps/web/src/test/renderWithStore.tsx` 没有 `AppI18nProvider`，现有 Composer 测试也未在用例中激活 locale；任何新增 `useLingui()` 的 Composer 子树都会因此无法渲染。
- 当前全仓 `tsc -b` 被 ModelConnection profile 的并发/存量类型漂移阻断，与本任务文件无关。

## 疑虑

- 本任务的验收要求指定 Composer 测试通过，但其测试装配文件不在允许修改清单中；在不扩展边界的前提下无法使该命令通过。

## 建议后续动作

- 由拥有测试范围的后续任务把 Composer 测试包在真实 `AppI18nProvider` 中，先 `activateLocale('zh-CN')`，完成后恢复中文；catalog 任务完成后再补真实 English 断言。
- 独立处理 ModelConnection profile 的 `model`/`models` 类型漂移后，复跑 `pnpm exec tsc -b`。
