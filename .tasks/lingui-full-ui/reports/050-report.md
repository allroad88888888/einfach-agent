# 050 对话 catalog 报告

## 提取与范围

- 首次 `pnpm lingui:extract --clean`：English 共 146 条，Missing 126 条；既有已审校词条为 20 条，因此本波新增 126 条。
- 审查结果：新增词条只引用 010–040 的聊天静态 UI：会话导航、转录壳、输入面和决策卡。唯一测试引用是既有的“新建工作区”词条；未发现任务外新增 message。
- 所有插值、rich-text tag 与动态值均原样保留；未翻译工具名称、工具 payload 或其他动态内容。

## 翻译覆盖

- `en/messages.po`：146/146 条已翻译（本波 126/126 条为自然、简洁英文）。
- `zh-CN/messages.po`：146/146 条保留原中文。

## 验证

- `pnpm lingui:compile`：通过。
- 再次执行 `pnpm lingui:extract --clean`：English Missing 0。
- `pnpm exec lingui status`：未通过；当前 `@lingui/cli` 的命令列表没有 `status`，返回 `error: unknown command 'status'`。已用 extract 的 catalog statistics 验证 Missing 0。
- `git diff --check -- apps/web/src/i18n/locales`：通过。

## R1：计数词条 ICU plural

- 仅修改 `en/messages.po` 的 5 个计数译文：`stepCount` 的步骤数、展开/收起思考过程，`truncatedCount` 的字符数，以及 `incompatibleCount` 的历史图片数。
- 每个译文均使用合法 ICU `plural` 的 `one` 与 `other` 分支，保留原变量；count 为 1 时分别显示 `1 step`、`1 character` 或 `1 historical image`。
- `pnpm lingui:extract --clean`：English 146 条，Missing 0；`pnpm lingui:compile`：通过；`git diff --check -- apps/web/src/i18n/locales`：通过。
