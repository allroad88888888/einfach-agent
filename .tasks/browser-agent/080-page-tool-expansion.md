---
id: '080'
title: 页面工具覆盖内容读取与下拉表单操作
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-sol
status: done
repair_round: 1
base: 756cd97
files:
  - browser-agent/tools/page/**
---
# 页面工具覆盖内容读取与下拉表单操作

## R1 独立审查修正
依据 reports/080-review.md：read_page/read_table共同可见性过滤补充关闭details（summary仍可见）与visibility:collapse；覆盖页面正文、表格目录、caption/cell。新增readPage/readTable同源iframe跨realm测试，避免NodeFilter依赖外部全局（使用document所属window或DOM常量）。100的preview集成已有iframe调用，作为补充证据，但页面包自身应有独立验收。只修报告范围及就近测试，不改其他包；复验受影响测试/build并更新080报告。

用户要求增加工具。实现、测试、文档全部属于本任务；仅修改 browser-agent/tools/page/**，报告写 .tasks/browser-agent/reports/080-report.md。阅读 index.md 的全局约束。不得自行提交或启动浏览器。按 one-file-one-thing 每文件普通≤300行；每个新工具一目录，实现+.md+测试。先在报告列新模块职责。

## 现状
已有 read_form/fill_fields/validate_form，公开 PageToolsHost 的 readForm/fillFields/validateForm；createDomPageHost 使用 WeakMap 字段身份、PageRef、跨 realm DOM 判断、document-write-queue 和逐字段回读。复用它们，不碰 core、agent、extension、ui。ToolContext 仅 sessionId/signal。默认填充不提交。

## 新增6个模型可见工具
- read_page：读取当前绑定文档的标题、URL、可见正文文本与表格清单；排除 script/style/template、隐藏内容、密码/hidden input，不读 input/textarea 当前值，输出有界。正文缺省12000，最大20000字符；表格最多50。iframe只读绑定 document。
- read_table：凭 read_page 的 PageRef+tableId 读取语义HTML表格，返回 headers/rows，offset+limit 分页（缺省20、最大100），单cell最大500字符、最多50列，标明截断。tableId WeakMap稳定身份，替换节点旧id失败；不要抓任意selector，不跨绑定文档。
- read_field_options：凭 PageRef+fieldId 读对应字段候选项，支持query过滤/offset+limit有界分页；区分没有 options 的不支持控件。复用readForm且核对PageRef。
- wait_for_field：凭 PageRef+fieldId 等待 ready（supported且非readOnly）/有options/指定value；有界轮询，缺省5秒最大30秒，AbortSignal立即取消并清理timer；超时返回受控失败，不用busy loop，不因节点替换同label而重定向。异常/导航不能报success。
- select_option：凭 PageRef+fieldId 选择精确 value（单选string、多选string[]），仅有options的字段；拒绝未知option，复用fillFields以保留写锁、过期身份检查和回读；replayUnsafe、serial page:write。
- clear_fields：凭PageRef+fieldIds批量清空，文本''，checkbox/radio false，多选[]，单选仅有空option才清空否则逐项失败；controlled字段根据read value类型选择清空值。复用fillFields；逐项partial failure；replayUnsafe/serial。

后4个工具基于现有PageToolsHost方法实现，保持既有自定义host兼容。新增只读host方法可选，只有存在对应方法才注册read_page/read_table；DOM host与扩展host实现二者；其余注册原3+新4=7，完整DOM host=9。
对导出方法和类型按以下合同实现，供100消费，不另造底层宿主层：
```ts
interface PageReadInput { maxChars?: number }
interface PageSnapshot { page: PageRef; title: string; url: string; text: string; truncated: boolean; tables: readonly {id:string; caption:string; rowCount:number; columnCount:number}[] }
interface ReadTableInput { page: PageRef; tableId: string; offset?: number; limit?: number }
interface TableSnapshot { page: PageRef; tableId: string; headers: readonly string[]; rows: readonly (readonly string[])[]; nextOffset?: number; truncated: boolean }
interface PageToolsHost {
  // original methods unchanged
  readPage?(input: PageReadInput, ctx: PageCallContext): Promise<PageSnapshot>;
  readTable?(input: ReadTableInput, ctx: PageCallContext): Promise<TableSnapshot>;
}
```
这些类型在包根导出。新工具工厂createReadPageTool/createReadTableTool/createReadFieldOptionsTool/createWaitForFieldTool/createSelectOptionTool/createClearFieldsTool公开导出。schema要防非法参数，host公开方法同样守界限。不要把大量DOM内容挤进read_form。

## 验收
同目录注册工具测试验证真实DOM行为及registry拒参；覆盖内容排除和截断、table分页/旧id、field options/重复值、wait成功/timeout/abort/stale、select单多选/非法值、clear各kind及partial failure；复核跨realm。原页面包测试全通过，pnpm --filter @einfach-agent/tools-browser-page build，通过文件行数检查。仅跑相关测试，记录命令/数量，不重复全仓。文档README列9个工具和旧host兼容行为。完成报告精确schema供集成，不启动Chrome、不操作钥匙串。
