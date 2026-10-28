# 020 页面工具包交付报告

状态：DONE（R3）

## 公共接口

包根 `@einfach-agent/tools-browser-page` 导出：

```ts
type PageCallContext = Pick<ToolContext, 'sessionId' | 'signal'>
interface PageRef { targetId: string; documentId: string; revision: number }
type FieldValue = string | boolean | readonly string[]
interface FieldOption { label: string; value: string }
interface FormField {
  id: string; label: string; kind: string; value: FieldValue
  required: boolean; readOnly: boolean; supported: boolean
  options?: readonly FieldOption[]
}
interface FormSnapshot { page: PageRef; fields: readonly FormField[] }
interface FieldOutcome { id: string; ok: boolean; value?: FieldValue; error?: string }
interface PageToolsHost {
  readForm(ctx: PageCallContext): Promise<FormSnapshot>
  fillFields(input: { page: PageRef; values: readonly { id: string; value: FieldValue }[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
  validateForm(input: { page: PageRef; fieldIds?: readonly string[] }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>
}
interface ControlledFieldAdapter {
  readonly kind: string
  matches(element: Element): boolean
  read(element: Element): Omit<FormField, 'id' | 'kind'>
  write(element: Element, value: FieldValue, ctx: PageCallContext): Promise<void> | void
  validate?(element: Element): string | undefined
}
interface DomPageHostOptions {
  document: Document; targetId: string; documentId?: string; revision?: number
  controlledAdapters?: readonly ControlledFieldAdapter[]
}
function createDomPageHost(options: DomPageHostOptions): PageToolsHost
function createReadFormTool(host: PageToolsHost): Tool
function createFillFieldsTool(host: PageToolsHost): Tool
function createValidateFormTool(host: PageToolsHost): Tool
function createPageTools(host: PageToolsHost): readonly Tool[]
function registerPageTools(registry: ToolRegistry, host: PageToolsHost): void
```

`read_form`、`fill_fields`、`validate_form` 各自位于独立目录，包含实现、guide 和同目录测试。根入口只组合与导出。包的 `exports`、声明生成和 ESM 构建已补齐。

## 行为与覆盖证据

| 验收面 | 测试证据 |
| --- | --- |
| 原生字段读取 | text、textarea、select、multiple select、checkbox；label/aria-label、当前值、required、disabled/readOnly、options |
| 敏感与复杂字段 | password/hidden 不返回，adapter 也无法重新暴露；未适配 `role=combobox` / contenteditable 明确 `supported:false` |
| 填充与回读 | 各原生值类型、实际值回读、冒泡 `input` + `change`；浏览器规范化或事件回退返回 `ok:false` 与实际值；多选按集合比较 |
| 校验 | 原生约束失败和成功；值不变且不触发 submit |
| 受控组件 | 显式 adapter 优先接管原生或复杂元素、成功写入回读、自定义校验、原生 disabled 仍强制生效、异步取消后拒绝迟到成功 |
| 部分失败 | 同批包含成功、禁用、非法选项、不支持、缺失 ID、非法字段类型 |
| 身份与版本 | 重复 label 不串写；DOM 替换旧 ID 失败；targetId/documentId/revision 任一失配均在写前拒绝 |
| 取消 | 调用前取消不写；排队中取消在进入写入前拒绝；adapter 等待中取消在异步返回后再次检查并抛 AbortError |
| 串行与中途失效 | 同一 Document 的多个 host 共用 FIFO Promise 队列；失败不堵后续；每字段写前复核 document/PageRef/identity/disabled/signal，中途 document 失效后后续字段不写 |
| core 闭环 | 独立 `createCore` + `registerPageTools` + DOM host 完成 read → fill → validate |
| schema | registry 在 host 调用前拒绝数字字段值；工具 guide/schema/结构化结果均存在 |
| allowlist | 复用 core 现有 session capability gate；其定向运行时测试 12/12 通过 |

DOM host 用 `WeakMap<Element, id>` 记录已读控件身份，写前重新扫描并按身份解析，不用 label、name 或模型提供 selector 定位。按 `Document` 共享的轻量 Promise 队列串行批次，队列尾吞掉前序失败后继续；跨消息/会话的目标路由仍由 050 扩展桥负责。普通 DOM 值变化与候选项更新不会改变 PageRef；导航/重新绑定由扩展 host 生成新的 documentId/revision。DOM adapter 不跨页面保存强元素引用。

## 验证命令

- `pnpm exec vitest run browser-agent/tools/page`：R1 最终结果见下方；原交付为 6 个测试文件、15 个测试通过。
- `pnpm exec vitest run packages/agent-core/src/runtime/sessionCapabilityToolRuntime.test.ts`：1 个测试文件，12 个测试通过（禁用/锁定工具能力运行时围栏）。
- `pnpm --filter @einfach-agent/tools-browser-page build`：通过；R1 最终产出 ESM、source map 与 11 个声明文件，声明说明符修复通过。
- `node scripts/check-docs.js`：526 个 Markdown 文件检查通过。
- `git diff --check -- browser-agent/tools/page`：通过。
- 文件行数：所有新增源码与测试均小于 300 行；最大文件 95 行。

## R1 修复验证

- 修复审查的 4 个 Important：adapter 敏感字段绕过、adapter 无法接管原生元素、回读偏离仍报成功、DOM host 无共享写队列。
- 增补逐字段写前 document/PageRef/identity/disabled/signal 复核，中途 document 失效后不再写后续字段。
- 新增 `dom-host.r1.test.ts` 覆盖 8 个 R1 场景；连同原测试，`pnpm exec vitest run browser-agent/tools/page` 最终为 7 个测试文件、23 个测试通过。

## R2 集成类型修正

- 修正 `dom-host.r1.test.ts` 对必选 `Document.defaultView` 属性使用 `delete` 导致的 TS2790，改用 `Reflect.deleteProperty` 恢复测试实例上的临时遮蔽属性。
- 修正 `register.integration.test.ts` 在 `ToolResult` 的 pause 分支尚未排除前读取 `ok` 导致的 TS2339；现在先用 `'ok' in read` 收窄，再断言成功结果。
- 将 adapter 等待中取消用例改为显式 `entered` 信号：测试先等待 `write` 进入并阻塞于 await，再 abort/release；断言调用以 `AbortError` 拒绝、第一字段只体现 adapter 已产生且不可回滚的外部写入、第二字段保持未写。该证据与“排队中取消”用例不再重复。
- `pnpm exec vitest run browser-agent/tools/page`：7 个测试文件、23 个测试通过。
- `pnpm exec tsc -p browser-agent/tools/page/tsconfig.json --noEmit`：通过，检查包含全部测试源码。
- `pnpm --filter @einfach-agent/tools-browser-page build`：通过，ESM、source map、11 个声明文件及声明说明符修复均成功。

## R3 同源 iframe realm 兼容

- 新增真实 `iframe.contentDocument` 回归测试；修复前该文档中的原生控件全部因父页面 realm 的 `instanceof` 判定而被漏掉，两个新增用例均失败。
- 原生 input、textarea、select 的识别改为严格 HTML namespace 与 local name 守卫；敏感 input 排除、label 查找、可写检查、读值、写值和约束校验共享同一组 realm 无关判据。
- `input` / `change` 事件使用控件 `ownerDocument.defaultView.Event` 构造，避免把父页面 realm 的事件派发到 iframe 元素。
- 新增覆盖 frame 文档中的 text、select、multiple select、checkbox，password/hidden 排除，显式 label，read → fill → validate 闭环，以及两个不同 Document 的字段身份和写入隔离。公开接口未变化；这只支持调用方可直接提供的同源 iframe Document，不扩大为跨源 iframe 支持。
- `pnpm exec vitest run browser-agent/tools/page/src/dom-host.iframe.test.ts`：修复前 1 文件 2 测试失败；修复后 1 文件 2 测试通过。
- `pnpm exec vitest run browser-agent/tools/page`：8 个测试文件、25 个测试通过，既有 adapter 优先、敏感字段、Document FIFO、迟到取消及回读检查覆盖保持通过。
- `pnpm exec tsc -p browser-agent/tools/page/tsconfig.json --noEmit`：通过，包含全部测试源码。
- `pnpm --filter @einfach-agent/tools-browser-page build`：通过，ESM、source map、11 个声明文件及声明说明符修复成功。
- `node scripts/check-docs.js`：532 个 Markdown 文件检查通过。
- `git diff --check -- browser-agent/tools/page .tasks/browser-agent/reports/020-report.md`：通过。

## 未验证项与边界

- 未使用真实 Chrome content-script 文档或真实客户受控组件；扩展桥与真实页面路由属于 050。当前证据来自 jsdom DOM 和确定性 adapter fixture。
- 未做 Edge 实机验证；按任务树属于发布检查。
- 异步 adapter 必须观察传入的 `ctx.signal` 才能阻止其自身在取消后继续产生内部副作用；DOM host 会在 adapter 返回后再次检查并拒绝把迟到结果报告为成功，但无法回滚第三方 adapter 已执行的外部写入。
- 对话 undo 不撤销页面外部副作用，README 与工具 guide 已明确说明。
