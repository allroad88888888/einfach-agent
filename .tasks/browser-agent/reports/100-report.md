# 100 扩展桥与完整工具预览报告

## 结果

- 扩展 `ExtensionPageBridge`、协议、content script 与 service worker 已支持 `readPage` / `readTable`，类型全部从 page 工具包根出口消费。
- `readTable` 在发送前校验会话绑定的 `PageRef`；新读取沿用原 target、document generation、取消路由。service worker 仅对 `fillFields` 传输失败标记 `unknownResult`，因此经该消息执行的填充、选择、清空仍保留未知写结果语义，只读失败不会误报为未知写入。
- UI fixture 注册真实 page/api registrar。DOM host 只持有同源业务 iframe 的 `Document`，业务页包含文本、单选、多选、checkbox、国家依赖城市、异步选项和语义表格；Agent 配置 DOM 不在 host 边界内。
- fixture API source 提供中文 label/description 和固定本地城市数据；模型 transport 使用固定本地响应，不访问 `fixture.invalid`，API key 仍为演示内存/fixture 配置值。
- 配置预览模型可见 catalog 为 13 项：11 个业务工具加 `skill_search`、`skill_read`。示例 Agent 默认选择常用读取、字段操作和校验工具，不强制全选。
- embedded 示例保留原 mock 请求顺序，同时把完整 11 个业务工具列为 Agent 可选能力；README 增加完整清单与预览命令。

## 覆盖审计

| 消费面 | 结果 |
| --- | --- |
| DOM registrar | `createDomPageHost` 提供 9 个 page 工具所需能力，api registrar 提供 2 个 API 工具。 |
| legacy custom host | `readPage` / `readTable` 保持可选；未实现时只不注册这两个读取工具，其余依赖既有 `readForm` / `fillFields` 的工具仍可达。 |
| extension bridge | page registrar 可达 9 个 page 工具；`wait_for_field`、`read_field_options` 复用读取，`select_option`、`clear_fields` 复用写桥。 |
| preview fixture | 隔离 iframe + 本地 API host 装配完整 11 个业务工具，连同 skills 共 13 个模型可见工具。 |
| embedded | 继续从两个工具包根出口注册；默认 Agent allowlist 已覆盖完整业务工具。 |

## 验证证据

- `vitest run browser-agent/extension/tests browser-agent/ui/tests/tool-preview.integration.test.ts browser-agent/tools/page/src browser-agent/tools/api/src browser-agent/examples/embedded/tests`：20 files / 71 tests passed。
- preview 集成测试真实执行 `read_page`、`read_table`、`read_field_options`、`select_option`、`clear_fields`、`wait_for_field`、`list_options_sources`，并断言 iframe document 与配置 document 隔离及完整 13 项 catalog。
- `@einfach-agent/tools-browser-page`、`@einfach-agent/tools-browser-api`、`@einfach-agent/browser-agent-ui`、`@einfach-agent/browser-extension`、`@einfach-agent/example-embedded` build：通过。
- 根 `tsc -b`：通过。
- `node scripts/check-docs.js`：通过。
- `pnpm check:state`：通过；fixture 辅助模块使用仓库认可的 `*.testFixtures.ts` 命名，不扩大产品源码扫描白名单。
- 运行中的 Vite fixture 服务可解析 `fixture.testFixtures.tsx` 及重命名后的两个辅助模块，未启动额外浏览器。
- 新增/大改源码与测试文件均少于 300 行；fixture HTML 数据不受行数限制。

编排者已通过 CUA 完成真实可见 UI 验收，配置页完整显示 13 个工具；证据见 `100-browser-check.md`。执行者未运行旧 CDP/browser smoke 脚本，也未启动浏览器。100 最终 done 仍等待 080/090 独立审查结论。
