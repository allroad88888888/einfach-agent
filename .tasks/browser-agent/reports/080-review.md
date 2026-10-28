# 080 独立审查

结论：**REJECTED**

审查方式：只读任务文件、执行报告、`080-scope.diff` 与范围内产品源码/测试；未修改产品代码，未重跑执行者已记录的测试。

## 验收逐条核对

- ✅ 新增六个模型可见工具并按合同导出：`read_page`、`read_table`、`read_field_options`、`wait_for_field`、`select_option`、`clear_fields` 的工厂与四个公开读取类型均从包根导出；`PageToolsHost.readPage/readTable` 保持可选。
- ✅ 注册兼容：完整 DOM host 注册 9 项；没有可选读取方法的旧 host 注册原 3 项与新增 4 个字段工具，共 7 项。`register.integration.test.ts:35-41` 有兼容与 registry 拒参证据。
- ❌ `read_page` 的“可见正文/隐藏内容排除”未完整满足。`dom-page-read.ts:3-12` 仅认 `hidden`、`aria-hidden=true`、`display:none`、`visibility:hidden`，会读取浏览器中不呈现的关闭 `<details>` 内容，也未处理 `visibility: collapse`。现有测试 `read-page.test.ts:5` 只覆盖内联 `display:none`，因此“可见正文”合同仍可被实际页面违反。详见 Important 1。
- ✅ `read_page` 正文默认 12000、最大 20000，排除 script/style/template 及 input/textarea/select 文本，表格目录最多 50；直接 host 对 `maxChars` 做整数与范围检查。
- ✅ `read_table` 使用 WeakMap 元素身份，替换节点后旧 ID 失败；默认 20/最大 100 行、50 列、单元格 500 字符，分页、截断与 PageRef 检查均有实现及测试。
- ✅ `read_field_options` 复用 `readForm` 并核对 PageRef/字段身份；支持 query、offset、limit，保留重复 value；无 options 返回受控失败。
- ✅ `wait_for_field` 支持 ready/options/value、默认 5 秒/最大 30 秒、有界 100ms 轮询；deadline 包住悬挂的 `readForm`，父 signal 能立即取消，timer/listener 在结束路径清理；字段替换和 stale PageRef 不会重定向为成功。
- ✅ `select_option` 只接受暴露 options 的字段，校验单/多选值形状、重复请求值与未知值，并通过 `fillFields` 保留写锁、身份复核和回读；标记 `replayUnsafe` 且串行 `page:write`。
- ✅ `clear_fields` 按当前 value 类型生成 `''`/`false`/`[]`，单选无空 option 时逐项失败，其余项继续通过一次 `fillFields` 写入并按请求顺序合并结果；标记 `replayUnsafe` 且串行 `page:write`。
- ❌ “复核跨 realm”缺少新增读取路径的证据。范围内 `dom-host.iframe.test.ts` 是既有测试，只调用 `readForm`、`fillFields`、`validateForm`；新增 `visibleText` 还直接读取全局 `NodeFilter`（`dom-page-read.ts:23`），但没有 iframe document 上的 `readPage/readTable` 用例。详见 Important 2。
- ✅ README 列出 9 个工具、可选 host 方法和旧 host 7 项兼容行为；六个新工具均有同目录实现、说明与测试文件，新增/大改文件未见超过 300 行。
- ✅ 执行报告给出精确 schema，并记录包测试 14 文件/37 项、补充测试 2 文件/8 项、包 build、Markdown 检查、diff check 和行数检查通过。按独立 review 规则未重复运行这些命令。

## 质量发现

### Important 1 — “可见正文”会包含实际未呈现内容

位置：`browser-agent/tools/page/src/dom-page-read.ts:3-12,21-26`

`hiddenSelf` 把隐藏状态限定为四种检查。关闭的 `<details>` 中除 `<summary>` 外的后代在浏览器里不呈现，但其 computed `display`/`visibility` 通常仍不会命中这里；`visibility: collapse` 也没有被识别。`visibleText` 因而会把这些内容加入 `read_page.text` 或表格 cell/caption，违反“可见正文、排除隐藏内容”的验收合同，并可能暴露页面故意折叠的信息。

建议修复：用能表达实际 rendered/visible 状态的统一判定补上 `<details>` 关闭状态及 `visibility: collapse`（并明确项目对透明/零尺寸内容的口径），让正文、caption、row、cell 共用；增加对应真实 DOM 行为测试。

### Important 2 — 新增读取代码没有完成跨 realm 验收

位置：`browser-agent/tools/page/src/dom-page-read.ts:23`；`browser-agent/tools/page/src/dom-host.iframe.test.ts:17-35`

任务明确要求复核跨 realm，但现有 iframe 测试仅覆盖原有表单方法；新增 `readPage/readTable` 没有在 iframe document 上执行。读取实现又使用当前执行 realm 的全局 `NodeFilter`，而不是 `document.defaultView` 的常量或数值常量，使这一缺口具有实际兼容风险，也无法用现有证据确认表格身份与可见文本遍历在绑定文档 realm 中正常。

建议修复：从绑定 document realm 获取 TreeWalker 所需常量（或使用标准数值常量），并在同源 iframe document 中覆盖 `readPage`、取得 `tableId`、`readTable`、隐藏内容过滤及替换旧 ID 失败。

## 修复后复审门

1. 可见性判定修复，并有关闭 `<details>` 与 `visibility: collapse` 的回归测试。
2. 新增读取路径在 iframe document 的跨 realm 测试通过。
3. 执行者更新报告中的相关测试数量与命令；复审只检查修复 diff 与新增证据。
