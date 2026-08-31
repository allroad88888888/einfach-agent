PASS

# 030 独立审查

## 结论

- 未发现需要修复的 030 产品源码问题；R1 **不需要**。
- 四个目标文件中的可见固定文案、按钮、状态、`aria-label`、`title`、`placeholder`
  和带数量/名称/模式的固定插值框架，均已进入 `@lingui/react/macro` 的
  `useLingui().t`。
- 动态数据保持原样：用户草稿仍直接绑定 `draft`；附件文件名和图片宽高/MIME/字节数
  仍直接渲染或只作插值；`attachments.error`、原始 `runError` detail、`capability.reason`
  与 `notice.text` 都未被作为待翻译 message。401 判定仍只用本地化的固定提示替换摘要，
  `<code>{runError}</code>` 继续暴露服务端原始 detail。
- Lingui v6.6 macro 用法合法：本地 `@lingui/react` 为 6.6.0，
  `macro/index.d.mts` 明确导出带 tagged-template `t` 的 `useLingui()`；两项 Vitest 也已经
  Vite/Lingui macro 转换成功。
- 基线 diff 仅增加 Lingui 导入/hook，并把原有固定文案包入宏。`sendMessage`、
  `stopRun`、`setApprovalMode`、草稿/附件 atoms、图片能力判定、提交 settle 与附件校验/移除
  的条件、参数和事件处理均未改变；未引入新 state 或动态 atom。

## 独立命令与证据

1. `git rev-parse HEAD`
   - 输出 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1`，与 030 任务基线一致。
2. `git diff -- apps/web/src/agentNew/ui/Composer.tsx apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx`
   - 逐项核对上述静态/动态边界及行为边界；范围统计为 4 文件、44 行新增、37 行删除。
3. `pnpm exec vitest run apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx`
   - PASS，exit 0；2 files / 29 tests 全部通过。015 的 Provider 装配已使本叶原报告中的
     `useLingui()` 缺失不再复现。
4. `pnpm exec tsc -b`
   - FAIL，exit 2；无任何错误指向 030 的四个目标文件。
   - 失败均属任务外 ModelConnection 契约在途漂移：一类是 `ModelConnectionProfile`
     / `ModelConnectionProfileSaveInput` 从单个 `model` 迁移为必需的 `models`，UI、runtime、
     state 与多个 test fixture 仍混用旧新形状；另一类是 `ModelConnectionProfileHost`
     新的必需 `probe` 方法尚未补入测试 host stubs。报错位于
     `ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx` 及
     `apps/web/src/settings/**`，因此不触发 030 R1。
5. `git diff --check -- apps/web/src/agentNew/ui/Composer.tsx apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx`
   - PASS，exit 0，无输出。
6. `wc -l apps/web/src/agentNew/ui/Composer.tsx apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx`
   - 分别为 297 / 82 / 41 / 38 行，全部 ≤ 300；`Composer.tsx` 未超限。四文件仍各自只负责输入器、
     待发附件托盘、历史图片兼容性门禁、已发图片卡片，未扩张职责。

## 范围声明

- 按审查约束未运行 Lingui extract/compile，未修改产品源码、测试源码、PO/catalog、
  任务定义或 index；本次唯一写入是本审查报告。
