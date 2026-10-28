---
id: 370
title: 纯Web Agent能操作非原生下拉与任意已观察DOM控件
kind: leaf
parent: null
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-21
done: 2026-09-21
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/tools/dom
  - browser-agent/tools/page/src/index.ts
  - browser-agent/tools/page/src/read-form/read-form.md
  - browser-agent/tools/page/src/select-option/select-option.md
  - browser-agent/tools/page/src/read-field-options/read-field-options.md
---

# 纯Web Agent能操作非原生下拉与任意已观察DOM控件


## 目标与边界
D01/D02。一个独立可嵌入纯Web工具包，覆盖读取普通DOM节点、点击展开/选择、输入、按键、滚动、等待。针对真实无role候选div/span和挂body的弹层，必须通过真实事件handler完成选择并回读目标显示值。不要用业务class或编写专用DeepFOS适配器。390做独立审查，不由本agent审自己。
## 已有上下文
page/src/dom-host.ts持有字段WeakMap和PageRef；dom-logical-controls.ts把非原生控件supported:false。page/src/document-write-queue.ts提供同Document队列，本任务可仅在page/index.ts导出enqueueDocumentWrite供新包复用。保持既有field身份稳定。schema/导出/tsup/README参照tools/page，但不用一行挤完整实现。page三个指南补unsupported时转DOM流程与业务回读提示，不能假定展示文字=底层value。
新包build配置同page，依赖core和page workspace包。380负责根alias/importer和消费端依赖；本任务不碰这些文件。
## 固定共享合同（370产出，380消费）
新增包 `@einfach-agent/tools-browser-dom`（browser-agent/tools/dom）。类型直接复用 page 包 PageRef / PageCallContext，纯Web，不依赖Chrome/React。公开：
```ts
interface DomNode { ref: string; parentRef?: string; tag: string; role?: string; name: string; text?: string; value?: string; disabled?: boolean; readOnly?: boolean; expanded?: boolean; selected?: boolean; checked?: boolean; attributes?: Record<string,string> }
interface ReadDomInput { page?: PageRef; scopeRef?: string; selector?: string; text?: string; offset?: number; limit?: number }
interface DomSnapshot { page: PageRef; nodes: readonly DomNode[]; truncated: boolean; nextOffset?: number }
interface DomTargetInput { page: PageRef; ref: string }
interface TypeDomInput extends DomTargetInput { text: string }
interface PressDomKeyInput extends DomTargetInput { key: string }
interface ScrollDomInput extends DomTargetInput { direction: 'up'|'down'|'left'|'right'; amount?: number }
interface WaitForDomInput extends ReadDomInput { page: PageRef; condition?: 'present'|'absent'; timeoutMs?: number }
interface DomActionResult { page: PageRef; ref: string; dispatched: true; node?: DomNode }
interface DomToolsHost {
 readDom(input: ReadDomInput, ctx: PageCallContext): Promise<DomSnapshot>
 clickDom(input: DomTargetInput, ctx: PageCallContext): Promise<DomActionResult>
 typeDom(input: TypeDomInput, ctx: PageCallContext): Promise<DomActionResult>
 pressDomKey(input: PressDomKeyInput, ctx: PageCallContext): Promise<DomActionResult>
 scrollDom(input: ScrollDomInput, ctx: PageCallContext): Promise<DomActionResult>
 waitForDom(input: WaitForDomInput, ctx: PageCallContext): Promise<DomSnapshot>
}
createDomToolsHost(options: { document: Document; targetId: string; documentId?: string; revision?: number }): DomToolsHost
createDomTools(host: DomToolsHost): readonly Tool[]
registerDomTools(registry: ToolRegistry, host: DomToolsHost): void
```
工具名按方法顺序为 read_dom / click_dom / type_dom / press_dom_key / scroll_dom / wait_for_dom。每个工具一目录实现、说明、测试；公开类型全部从index导出。供service worker验证：`isDomSnapshot(value: unknown): value is DomSnapshot`、`isDomActionResult(value: unknown): value is DomActionResult`。验证包含PageRef、嵌套node类型与实际有界长度，不能只检查顶层数组。
`read_dom` 首次可不带page，其余行为必须包含当前PageRef和已观察ref；scopeRef用于从已观察容器缩小查询，selector/text作为read/wait过滤。读包含可见普通容器/文本节点的可操作Element引用，不限于ARIA交互节点；点击候选原本只是span/div也能触发冒泡handler。不猜测业务value。wait返回条件满足时的快照，超时抛出明确错误，不把dispatched当成业务成功。
如确需改合同，先发编排消息，不能单边更名。

## 验收标准
1. 6工具均真实registry可注册/schema加载，输入边界有校验，指南指导读取→观察引用→动作→回读。
2. 无ARIA普通div自定义dropdown（选项挂body/点击后异步出现/搜索输入过滤）完成展开→等候选→点安全漏洞→read显示选中；另测ARIA combobox与原生select原行为兼容。label/value不混淆，同名选项保留独立ref。
3. 节点ref在同document稳定，替换/移除/过期page/未知ref拒绝，无自动找另一个同文字节点代操作；隐藏/disabled/aria-disabled/readonly/password/hidden input不被写或泄漏敏感值；读取不能带script/style文本、任意敏感HTML属性。
4. 分页/字符/节点/扫描工作量有界，长页中能通过text或selector找到末尾目标（不能默默只搜前N节点）；隐藏祖先、inert、字段容器、弹层外点击处理正确。
5. 点击遵守页面事件流程，取消前后守卫，不发生重复click；输入触发框架可接收的input/change并回读，keydown/up说明不具可信默认行为，scroll回读；wait可取消、有截止时间与清理，不忙等或永久监听。read是只读，不隐式展开。
6. 与page写队列共享，测试DOM动作与fillFields串行不交错。失联或晚到结果不报告业务成功。
7. `pnpm exec vitest run browser-agent/tools/dom/src browser-agent/tools/page/src` 从仓库根执行，报告准确数；跑包build（待380接线）；类型问题不能靠any掩盖。
8. 报告 `.tasks/browser-agent/reports/370-report.md`，含文件职责/行数/边界限制。可以追加自己的370-*.log证据。

## 执行记录
- 370首轮交付：28files/71tests，page/dom builds通过；根tsc当时只剩并行380 mock类型推断缺口。源码冻结，独立370_review(sol)审查中。

### R1独立审查修复
370-review.md REJECTED：Important 1复合事件阶段取消/替换守卫；Important 2祖先aria-disabled/原生fieldset disabled含legend例外；Important 3实际ARIA combobox与native select行为验证。三项全部修复，重跑有针对性测试、刷新报告与源码diff后复审。编排附加点击序列窄修：pointerdown应使用目标realm PointerEvent可用时的真实构造（pointerType mouse），补pointerup；适用时focus按preventDefault语义且每个可重入阶段检查原节点/文档/signal，避免用户常见mousedown/pointerdown控件漏事件。不得扩为可信事件引擎。

- R1独立复审APPROVED，Critical/Important/Minor全部0，370正式done。
