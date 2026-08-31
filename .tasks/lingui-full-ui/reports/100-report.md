# 100 设置 catalog 报告

## Catalog

- `pnpm lingui:extract --clean` 初始统计：325 条 message，English 缺 179 条；既有 146 条 English 译文保留。
- 已逐条审核 179 条新增 message 的 source refs；全部仅来自 070–090 指定的模型、MCP、插件与 Skills 设置文件，未发现任务外 message。
- 179 条设置静态 UI 已补为简洁 English。provider、API Key、endpoint、server/plugin/skill 名称、URL、路径、命令与动态值均保持原样；计数使用 ICU `one` / `other`。
- 最终统计：`en` 325 total / 0 missing；`zh-CN` 325 total / 0 missing。

## 验证

- `pnpm lingui:extract --clean`：通过（最终 English Missing 0）。
- `pnpm lingui:compile`：通过，生成两种 locale 的 `messages.js`。
- `pnpm exec lingui status`：当前 Lingui CLI 不支持 `status`（`unknown command 'status'`）；以 extract 的内置 Missing 统计和直接 PO 统计替代，均为 0。
- catalog scoped whitespace check：通过；locale 目录现为新增未跟踪生成物，因此同时以 `git diff --no-index --check` 检查四个实际 catalog 文件。

## R1 修复

- 仅修正 `模型可见工具（{0}/{1} 未启用）` 的 English ICU：`tool` / `tools` 现在由总工具数 `{1}` 决定，未启用数 `{0}` 保持为原始动态值。
- 已运行 `pnpm lingui:extract --clean && pnpm lingui:compile`；最终 English 为 325 total / 0 missing。
- 运行时以编译 catalog 验证：`1/1` 为 `1 of 1 tool disabled`，`1/10` 为 `1 of 10 tools disabled`，`2/10` 为 `2 of 10 tools disabled`。
- locale scoped whitespace check：通过。
