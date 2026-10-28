---
id: '020'
title: 页面工具包可读取表单并可靠填充和校验字段
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files:
  - browser-agent/tools/page/**
---

# 页面工具包可读取表单并可靠填充和校验字段

## 目标与交付边界

一个 `@einfach-agent/tools-browser-page` 包，提供 `read_form`、`fill_fields`、`validate_form`。
这三项共用字段身份、文档版本、DOM 适配与逐字段结果；作为一个工具包 issue 独立实现、测试、说明。
不用安装 Agent 或 UI 包就可以注册到现有 core。Chrome bridge 由 050 实现，本叶产出可本地执行的 DOM adapter。

## 上下文与覆盖

- 工具范式：`tools/interaction/src/index.ts` 注册器，`packages/agent-core/src/tools/types.ts` 的 Tool/ToolResult。
- ToolContext 已有 sessionId、signal、progress；没有 tabId/runId，不假设这些字段存在。闭包注入 host，执行时透传上下文。
- `tools/interaction/src/browser-action/browser-action.ts` 仅渲染卡片，不能当页面自动化复用。
- `runtime/toolReversibility.ts` 与 `runtime/dangerousTools.ts` 是运行时分类，不等于工具自声明；未知写入沿用保守围栏。
- 覆盖 C05、C06；C11/C12 的扩展级路由、跨实例写锁由 050 消费本合同后负责。

## 接口（本任务新增、供 050 消费）

```ts
type PageCallContext = Pick<ToolContext, 'sessionId' | 'signal'>;
interface PageRef { targetId: string; documentId: string; revision: number }
type FieldValue = string | boolean | readonly string[];
interface FormField {
  id: string; label: string; kind: string; value: FieldValue;
  required: boolean; readOnly: boolean; supported: boolean;
  options?: readonly { label: string; value: string }[];
}
interface FormSnapshot { page: PageRef; fields: readonly FormField[] }
interface FieldOutcome { id: string; ok: boolean; value?: FieldValue; error?: string }
interface PageToolsHost {
  readForm(ctx: PageCallContext): Promise<FormSnapshot>;
  fillFields(input: {
    page: PageRef; values: readonly { id: string; value: FieldValue }[];
  }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>;
  validateForm(input: {
    page: PageRef; fieldIds?: readonly string[];
  }, ctx: PageCallContext): Promise<readonly FieldOutcome[]>;
}
function registerPageTools(registry: ToolRegistry, host: PageToolsHost): void;
function createDomPageHost(options: {
  document: Document; targetId: string;
}): PageToolsHost;
```

类型从包根 export。可增补受控组件 adapter 参数，但必须在本包 README 与报告给出精确签名，再由编排者同步 050。
模型 read_form 无任意 target/tab 参数；host 按 session 绑定目标。填充/校验使用读表单返回的 PageRef，宿主必须复核。
PageRef 是一致性标识，不作为权限凭证；字段 ID 不接受任意 JS 或能跳出绑定文档的 selector。
revision 表示宿主文档绑定代次，只在导航/目标重新绑定时递增；普通值变化、候选项刷新不递增。
字段 ID 绑定本次读取识别出的控件身份；写前重新解析并比对，控件被替换时旧 ID 失败，重新 read_form 获取新 ID。
不得把任意 MutationObserver 事件都算文档换代，否则正常级联下拉会使后续填充全部失效。

## 行为要求

1. 返回 label/值/候选项/必填/可写/支持状态；不全量复制 DOM，不读取密码或隐藏 token 字段。
2. 支持 text/textarea/select/checkbox/radio 与一个显式受控组件 adapter fixture；复杂未适配组件返回不支持。
3. 按控件要求设置值、触发相应 input/change、回读结果；逐字段报告实际结果，不因部分失败宣称整表成功。
4. validate_form 使用约束与当前值，仅验证，不自动提交表单、不触发默认 submit。
5. 文档导航、字段被替换、版本失效、禁用字段与取消信号都必须在实际写入前复核；异步 adapter 返回后再次防迟到。
6. 每次写入在宿主串行调度下可执行；只依赖当前 DOM 不跨页面保存元素引用。未知写入结果不由工具自行重试。
7. 工具 guide/schema/结构化返回齐全；使用原生 core ToolContext 和 ToolResult，业务数据不渲染 UI。

## 验收标准

1. `pnpm exec vitest run browser-agent/tools/page`：原生字段读/填/校验、受控组件回读、部分失败、缺失字段、非法类型。
2. 独立 core + registerPageTools + 本地 DOM host 能完成闭环；allowlist 禁用工具时执行被现有 runtime 拒绝。
3. 取消前/等待中、DOM 替换、PageRef 失效、重复标签不同字段的负例，确认不误写另一个字段/文档。
4. `pnpm --filter @einfach-agent/tools-browser-page build` 通过；工具与 DOM adapter 可分别使用，导入无 Chrome/React。
5. README 包含只用 core 的注册示例、扩展 host 合同、嵌入直接 DOM 示例、组件支持边界及外部撤销边界。

## 执行记录

- 2026-09-18：010 已交接本包骨架；依赖的是现有 core/tools，取消对 BrowserAgentClient 实现的串行等待并派发。
- 本包已有未提交 manifest/空入口/构建配置作为输入；现在本任务独占 browser-agent/tools/page/**，可补齐自己的 build/exports。
- 报告 `reports/020-report.md`，审查 `reports/020-review.md`。不得修改其他工具包、core 或根 lockfile。

- 2026-09-18：执行者交付 DONE，进入独立审查；尚未标为 done。

## R1 修复

- reports/020-review.md REJECTED，修复 4 个 Important 并分别补负例：敏感字段即使 adapter 匹配也不可读；显式 adapter 优先于原生适配；写后回读与请求值不一致时 ok:false 并返回实际值；同文档异步批次写入串行。
- 裁决：DOM host 负责其实际写队列，跨消息/会话路由仍归 050 — 嵌入客户直接使用 DOM host 也须有稳定顺序 — 用按 Document 共享的轻量 Promise 队列，不能引入通用调度框架；失败不堵队列，排队取消在进入实际写入前拒绝。
- 写入前每个字段都复核当前 document、PageRef、element identity、有效 disabled/readOnly 与 signal。异步 adapter 或页面事件改变文档/字段后，下一字段不能继续向失效 document 写；补中途变化场景。
- 明确多选集合比较语义，不依赖请求数组排序；回读失败仍提供实际结果供调用方判断，不掩盖部分成功。
- 仅改本包与原执行报告；原有 15 项定向 + 12 项 allowlist 通过，新增负例必须单独报告。

- 2026-09-18：R1交付DONE，23项定向测试通过，进入复审 reports/020-review-r1.md。

- 2026-09-18：R1独立复审PASSED，编排亲验dom-host.r1+api合计25项通过，020标done。Minor：旧等待取消用例因FIFO微任务实际在启动前取消，产品await后检查正确；由050实际等待中取消场景补端到端证据，不开修复循环。

## R2 集成类型修正

- 010收尾全仓build发现本包测试类型错误，重新打开：dom-host.r1.test.ts:93 TS2790(delete必选属性)，register.integration.test.ts:16 TS2339(ToolRunResult未先收窄ok)。修正测试合法类型表达，不用@ts-ignore。
- 同时修复R1复审Minor：异步adapter测试显式等待write进入再abort，真正覆盖await后的取消检查。
- 验证本包Vitest与包含测试的本包tsconfig noEmit；UI在途类型错误不归本任务。报告更新后范围复审，不修改其他包。

- 2026-09-18：R2交付DONE，7文件23测试、本包含测试tsc noEmit通过；进入测试范围复审。

- 2026-09-18：R2范围复审PASSED；编排亲验本包tsc noEmit通过，恢复done。R1唯一Minor测试时序也已关闭。

## R3 集成发现：同源 iframe Document

- 050嵌入示例按既定隔离目标，为两个client传入各自frame.contentDocument。编排抽查发现DOM host使用创建host所在realm的全局HTMLInputElement/HTMLSelectElement/HTMLElement instanceof，跨realm控件会被判unsupported/label不正确。
- 此为本包公开document参数的实际消费者缺口，020重开R3，依skill由新的sol执行者接管（原020不再写）；只修browser-agent/tools/page/**与本报告，不更改公开合同，不改050示例或其他包。
- 以真实同源iframe DOM写失败测试复现，再修realm无关的原生控件识别/可写检查/读值/标签/验证；同时password/hidden排除、adapter优先、Document队列、回读检查必须保持。
- 至少覆盖frame.contentDocument中的text/select/multiple/checkbox、password/hidden排除、字段标签、读→填→校验、两个不同Document互不串字段。不能仅mock instanceof。
- 使用元素ownerDocument所在realm或严格DOM tag/namespace类型守卫，避免依赖parent window构造器；不要为此新增SDK/通用框架或绕过类型检查。
- 跑本包Vitest、本包含测试tsc noEmit、包build、docs。原报告增加R3实测与兼容说明，不把同源iframe修复扩大为跨源iframe支持。

- 2026-09-18：R3交付DONE；真实iframe测试修前2失败→修后通过，本包8文件25测试、tsc/build/docs通过。进入R3独立复审。

- 2026-09-18：R3独立复审PASSED；编排亲验iframe定向2/2通过，020恢复done，保留全部原保护。同源可访问Document支持已交接050。
