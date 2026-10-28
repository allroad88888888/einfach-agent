---
id: 380
title: 扩展和嵌入Agent能调用DOM工具完成自定义下拉选择
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
  - browser-agent/extension
  - browser-agent/examples/embedded
  - browser-agent/ui/tests
  - browser-agent/ui/package.json
  - browser-agent/README.md
  - tsconfig.app.json
  - vite.config.ts
  - scripts/check-boundaries.js
  - scripts/check-boundaries.test.js
  - pnpm-lock.yaml
---

# 扩展和嵌入Agent能调用DOM工具完成自定义下拉选择


## 目标与交付边界
D03/D04/D05。让370的独立DOM工具真正进入扩展和无UI嵌入宿主、配置工具目录、模拟模型真实registry调用闭环，并移除真实扩展默认fixture-cities。这是Chrome文档路由与公开consumer的独立风险边界。与370并行依固定合同实现，最终done依赖370交付与独立审查通过；不修改370所有文件。
## 上下文
extension/src/protocol.ts PageMethod5项；ExtensionPageBridge拥有bind/restore/assertPage/call；content-script.ts把createDomPageHost绑定同documentId/revision；service-worker.ts做请求/返回检查、sender/文档检查和fillFields未知写结果保护。扩展无需新权限。优先让ExtensionPageBridge同时implements DomToolsHost复用call，不另造binding系统；content初始化createDomToolsHost同PageRef。service-worker补isWriteCall全部DOM动作，读/wait也校验当前document，返回复用370 validators。旧network-main预捕获不可破坏。
sidepanel.tsx目前创建fixture-cities并注册API工具。移除真实扩展fixtureSource，可保留空来源apiHost或省API注册，选择对已有配置兼容方案并在报告说明。fixture/embedded演示数据源仍可存在。
根vite.config.ts/tsconfig.app.json需新包alias，scripts/check-boundaries.js browserSourcePaths显式加dom及fixture自测。pnpm-lock新增workspace链接不要改resolution/lockfileVersion。需要本地node_modules workspace symlink可手工创建，绝不pnpm install。
ui/tests/fixture-business.testFixtures.ts/fixture.testFixtures.tsx是可见预览，embedded/src/main.ts是双client无UI；都装DOM工具。加可重现非原生下拉的fixture与“运行DOM选择演示”入口，按钮必须调用真实ToolRegistry/host链（不是按钮直接手工选择业务项），显示每一步与回读结果，编排CUA可以点击测试。真正会话用mock fetch断言模型得到DOM schemas且通过run完成选择，不能只数catalog。
配置Agent与session有toolNames冻结语义，保持用户已存选择不自动扩权，新增工具在目录可选；文档说明已有Agent需勾选DOM工具并新建会话。
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
1. DOM六方法通过bridge→service→content（测试组合）路由到绑定document，未知method/payload/错误target/sender/导航/取消拒绝，返回validator拒绝错页或畸形nested node。
2. 新DOM写动作失联明确unknownResult且不自动重放；拒绝已取消写；共享原绑定、requestId与cancel通道。
3. extension和embedded实际注册新工具，UI目录展示且配置Agent选择后模型schemas包含并可实际调用，既有冻结会话能力不被暗改。
4. 真实registry+mock模型集成完成非原生dropdown展开/异步选项/点击回读“安全漏洞”，至少两个会话/目标隔离；本地可见fixture按钮走同一工具链。无需真实模型或业务提交。
5. 真实extension源内无fixture-cities/演示城市默认数据，demo允许使用。原生form/网络预采集/消息undo与无redo回归保留。
6. 根相关vitest、tsc -b、page/dom/extension/embedded build、state/boundaries/docs/diff门通过，报告标清自己跑过哪些，根统一完整相关回归不反复运行。包dist解析和no React/Chrome/Node依赖验证。
7. 报告 `.tasks/browser-agent/reports/380-report.md`，文件职责/行数/适用范围/未实测项，不自行浏览器交互。日志380-*.log。

## 执行记录
- 首轮10files/40tests、4build、tsc/state/boundaries/docs通过；独立380-review REJECTED，R1两项验收缺口：真实bridge→service-worker→content-script六方法组合、取消/导航/畸形返回；mock core必须消费并断言两个目标各自PageRef+选中显示的最终工具回读，不以外部DOM文本代替。修复包括必要产品bug，不只补假模拟；370 R1合同不变。

- R1源码冻结：实际bridge→service→content六方法组合及取消/导航/错页/畸形返回、mock双目标工具回读均补齐；9files/37tests、tsc/docs/diff通过，等待独立复审。

- R1独立复审APPROVED，Important全部关闭；根最终72files/254tests与extension/embedded build通过，380正式done。
