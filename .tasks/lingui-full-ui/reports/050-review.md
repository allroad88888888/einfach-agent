# 050 独立审查

状态：`PASS`

## 结论

R1 已仅修正指定的 5 条 English 计数译文。五条均为合法 ICU `plural`，包含 `one` / `other`，
count 为 1 与 2 的 compiled runtime 输出均自然；数量、来源边界、既有 20 条、中文、变量、富文本和
PO/compiled JS 一致性全部通过，未发现剩余问题。

## 数量与范围证据

- `en` 与 `zh-CN` 各 146 条非头部词条；两边 message id 集合完全相同。
- `en` 空 `msgstr` 0 条；`zh-CN` 空 `msgstr` 0 条（PO 头部的空 `msgstr` 不计词条）。
- 按 PO source reference 分区，恰有 126 条引用 010–040 的 14 个允许组件，另外恰有 20 条只引用既有
  L10 surface：`WorkspaceSidebar` 14、`WorkspaceRootField` 2、`LanguageSwitcher` 1、`AppShell` 3。
  唯一额外测试引用是既有“新建工作区”词条的 `renderWithStore.test.tsx`，没有产生额外 message。
- 既有 20 条英文仍为已审校值；其动态工作区名 `{0}` 保持插值，且当前 AppShell、WorkspaceSidebar、
  WorkspaceRootField、LanguageSwitcher 英文断言与这些译值一致，未见损坏。
- 126 条新增词条没有来自设置面、宿主或协议文件的 source reference。工具名 `{name}` / `{toolName}`、
  stage title、block reason、文件名等动态值只作为插值保留；未发现模型回复、用户输入或工具 payload 被写入
  `msgstr`。
- 共 25 条含插值的词条（其中 1 条同时含 rich-text tag）；全部 146 条的 `msgid` / `msgstr` 变量名集合
  相同，五条新增 plural 语法均可编译。`zh-CN` 的 146 条 `msgstr` 全部逐字等于 `msgid`；
  `<0>{toolName}</0>` 在两种 locale 与 compiled JS 中均保持完整。
- compiled JS 两边各 146 个 key，key 集完全一致；由 PO `msgid` 重新生成的 146 个 Lingui id 均存在，
  无多余 key。除单独核验的 rich-text 词条外，另外 145 条逐条重新编译后的 AST 与 JS 完全一致。

## R1 复审

### 变更范围

English PO 恰有 5 条 `plural`，且正是 R0 指定词条：

- `en/messages.po:40`：步骤数。
- `en/messages.po:164`：展开思考过程步骤数。
- `en/messages.po:233`：截断字符数。
- `en/messages.po:282`：不兼容历史图片数。
- `en/messages.po:367`：收起思考过程步骤数。

把这五条在内存中还原为 R0 译值后，English PO SHA-256 为
`5730e003b872171d3a458f8fd41c96da2affcbffc87a5ce2e7eaad18dfa1f417`，与 R0 审查记录完全一致；因此
English PO 除这五条外没有任何字节变化，既有 20 条也未动。当前中文 PO SHA-256 仍为
`28686e32b67cf017bd1ee19789d015fd7b8623908f669b647ace78e73cad531c`，也与 R0 完全一致。

### compiled runtime 证据

直接以 `@lingui/core` 加载当前 compiled English catalog，count 1 / 2 输出分别为：

- `1 step` / `2 steps`
- `Expand reasoning, 1 step` / `Expand reasoning, 2 steps`
- `Truncated 1 character` / `Truncated 2 characters`
- `1 historical image` / `2 historical images`（其余句子不变）
- `Collapse reasoning, 1 step` / `Collapse reasoning, 2 steps`

compiled JS 两边仍各有 146 个 key。English 5 条 plural AST 与 PO 一致；除单独核验的 rich-text 词条外，
其余 145 条逐条重新编译的 AST 与 JS 一致。全部 146 条变量名集合无差异。

## 独立命令

- `pnpm lingui:extract --clean`：通过；统计为 `zh-CN 146`、`en 146 / Missing 0`。
- `pnpm lingui:compile`：通过。
- `pnpm exec lingui status`：退出 1，当前 Lingui CLI 不提供 `status`，报
  `error: unknown command 'status'`；以上 extract 统计作为 Missing 0 的替代证据。
- `git diff --check -- apps/web/src/i18n/locales`：通过，无输出。
- extract 与 compile 前后四个 locale 文件的 SHA-256 均未变化；当前 English PO / JS 分别为
  `c6821e97...8e70e` / `212e2c25...5eb8`，中文 PO / JS 分别为 `28686e32...531c` /
  `1fc03077...9f5fd`，证明命令可重复且本次审查未改生成物。
- scoped Git 说明：`apps/web/src/i18n/locales/` 在当前基线中整体为 untracked，普通 `git diff -- <path>`
  无内容；因此使用完整 PO 内容审计、source-reference 分区、编译 id/AST 对照及前后 hash 补足证据。

本审查仅写本报告，未修改产品、测试、PO、compiled catalog、任务定义或 index。
