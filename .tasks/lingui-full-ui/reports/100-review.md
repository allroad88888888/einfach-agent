# 100 设置 catalog 独立审查

状态：`PASS`

## 结论

R1 只修正了指定的「模型可见工具」English ICU 译文，单复数现已由总工具数 `{1}` 决定。
325 条 English / Chinese catalog 的数量、Missing、旧译保护、变量/富文本标记与 PO/compiled JS
一致性全部通过，未发现剩余问题。

## R1 定点复审

`en/messages.po:905` 当前译文为：

```text
Model-visible tools ({0} of {1, plural, one {# tool} other {# tools}} disabled): Selecting a tool adds it to the model context and execution path. Select only tools you trust.
```

- ICU `plural` 选择器是总工具数 `{1}`；未启用数 `{0}` 仍是独立动态值，两个变量均完整保留。
- 直接加载当前 compiled English catalog 的 Lingui runtime：`1/1` 输出 `1 of 1 tool disabled`，
  `1/10` 输出 `1 of 10 tools disabled`，`2/10` 输出 `2 of 10 tools disabled`；三组均自然。
- 在内存中只把该条译文还原为 R0 值后，重建 English PO SHA-256 精确回到
  `ba518996f108b6b7150dea77f516e74b3db79890471420d361852b9fe738c6e0`，重建 compiled JS 也精确回到
  `101b140737cc069a6ead5a1981f02610e07d20c7b56ac9011b0504e73761e14a`，与 R0 审查记录完全一致。
  因此 R1 除该 message 的 English PO 及对应 compiled AST 外无其他 catalog 变更。

## 数量、范围与旧译保护

- `en` 与 `zh-CN` 各 325 条非头部词条；两边 message id 集完全一致。
- English 空 `msgstr` 0，Chinese 空 `msgstr` 0；Chinese 325 条 `msgstr` 全部逐字等于 `msgid`。
- 按 source reference 分区恰为旧 146 条、新 179 条。新 179 条的每一个 reference 都只来自 070–090
  指定的 16 个设置文件，无任务外来源；`McpCredentialField.tsx` 本身产生 0 条，与 080 报告一致。
- 「、」「删除」「工作区」3 条旧 message 新增了设置来源 reference，但仍归旧 146 条。从当前 PO
  过滤掉 179 条新 message 并移除这 3 条的新 reference 后，重建的旧 English PO SHA-256 为
  `c6821e97a8b48c7dd1b7ea068b71da84caad8c8d2114d03fddfeff9e6028e70e`，Chinese PO 为
  `28686e32b67cf017bd1ee19789d015fd7b8623908f669b647ace78e73cad531c`；两者均与 050 R1 审查记录完全一致，
  证明旧 146 条译文未损坏。

## Token、动态数据与 compiled 一致性

- 对 325 条逐条比较 ICU 变量名与 rich-text tag 名集：English 0 mismatch，Chinese 0 mismatch。
- 179 条新译文中的 provider/协议/安全字面量保持原样，包括 `OpenAI`、`Kimi`、`DeepSeek`、
  `GLM`、`MCP`、`stdio`、`Streamable HTTP`、`mcpServers`、`CORS`、`BYOK`、URL scheme、loopback 地址、
  `pnpm serve`、`key=value`、skill/plugin 路径与 `SKILL.md`。
- source 对照确认 credential label、server name/target/args/cwd/command line/env names/error、endpoint URL、
  plugin/skill name/description/diagnostic/tool name、workspace/source path 及资源数都作为插值或直接数据渲染；
  诊断内容、header/env 键值、命令和 payload 没有进入译文。
- 直接解析两个 compiled JS：各 325 keys，无缺失、无多余。对每条 PO `msgstr` 重新 `compileMessage`
  后与 JS AST 比较，English 0 mismatch，Chinese 0 mismatch。

## 独立命令

1. `pnpm lingui:extract --clean`
   - exit 0；`zh-CN 325`，`en 325 / Missing 0`。
2. `pnpm lingui:compile`
   - exit 0；两种 locale 编译成功。
3. `pnpm exec lingui status`
   - exit 1；当前 Lingui CLI 不支持 `status`，报 `error: unknown command 'status'`。以 extract 内置统计与
     PO 直接解析的双重 Missing/empty 统计替代。
4. 自定义 Node 只读审计
   - 结果：旧/新 `146/179`，新条目越界 0，token mismatch 0，PO↔JS key/AST mismatch 0，
     Chinese 非原文 `msgstr` 0；R1 的三组 runtime 输出全部通过。
5. `git diff --check -- apps/web/src/i18n/locales`
   - exit 0，无输出。locale 目录在当前基线整体 untracked，因此另对 4 个实际 catalog 逐一执行
     `git diff --no-index --check -- /dev/null <file>`；均只因「有新增 diff」返回 1，whitespace diagnostics 均为 0。
- R1 复审的 extract/compile 前后四文件 SHA-256 完全不变：English PO/JS 为
  `e0fee8b7...0fd2b` / `16998ab9...8f7a`，Chinese PO/JS 为 `021635c9...17af0` / `6f1340d5...16a0f`。
- scoped status 下 locale 目录只有 `en/messages.po`、`en/messages.js`、`zh-CN/messages.po`、
  `zh-CN/messages.js` 四个文件。

本审查仅写本报告，未修改产品、测试、PO、compiled catalog、任务定义或 index。
