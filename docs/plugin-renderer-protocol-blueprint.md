# 插件 UI Renderer 协议蓝图

> 文档状态：P2.5 的 R1–R4 已完成（`846743a`、`a2b8d97`、`66072f3`、`79bde78`）；R5 待实施。更新时间：2026-08-03。

## 结论

`agent-core` 应提供不含 React 的稳定时间线 item 投影协议；React 宿主拥有 renderer
registry。`PluginApi` 不新增 `registerRenderer`，Core 插件与 React UI 插件是两套独立的
安装面。这样外部 UI 包可以扩展展示，而 Core、CLI 和未来 server 不会获得 React 依赖或 UI
全局状态。

本协议先覆盖现有 Core 管理的对话与运行时显示数据；自定义、可持久化的插件时间线类型留到
后续专门的 schema 设计，不把 `unknown` payload 直接固化进会话格式。

## 已核对的现状

- 持久化的主时间线是 `ConversationItem[]`：其中的 `ModelItem` 表示 user、assistant、tool
  与 system 内容。
- Core 还维护不进持久化快照的 `AssistantStreamState`、`BrowserCard` 和
  `RuntimeTranscriptEvent`；它们仍是会话级、实例隔离的数据，而不是 React state。
- Web 的 `MessageList` 当前同时完成 Core 数据投影、思考分组、虚拟列表和 JSX 渲染。
  这使其成为既有超长文件；迁移时必须按职责拆分，不能在该文件继续叠加 registry。
- 现有公开 Core 插件入口已安全地提供工具、订阅、hook 和受限命令，但没有导出 React 类型。

这些事实意味着 renderer 的输入必须由 Core 的纯投影产生，不能让 renderer 直接读取
`itemsAtom`、命令、`ToolContext` 或内部 writers。

## 协议边界

### Core：稳定数据投影

Core 公共入口 `@web-agent/core/timeline` 只导出纯 TypeScript 类型与纯函数。
其输入是已有的会话项目和瞬态显示数据，输出为只读、按时间排序的 `TimelineItem[]`。v1 的
联合类型应精确表达当前已存在的可展示项目：

```ts
type TimelineItem =
  | TimelineMessageItem
  | TimelineReasoningItem
  | TimelineThinkingMessageItem
  | TimelineToolExecutionItem
  | TimelineRuntimeEventItem
  | TimelineBrowserCardItem

interface TimelineItemBase {
  readonly id: string
  readonly createdAt: number
  readonly sortKey: string
  readonly planStageId?: string
}
```

每个分支都应携带已经规范化的、只读的数据（例如 tool call 与已关联的 result），而不是把
`ConversationItem` 整块交给 UI 后再次猜测角色和关联关系。system 项目仍由投影层排除；孤立
tool result 必须成为确定的 tool-execution item，不能丢失。

Core 投影不负责以下展示策略：思考折叠、Markdown、工具结果摘要/截断、回退按钮、计划阶段
筛选、虚拟化和视觉样式。这些都属于 React 宿主。`BrowserCard` 的具体卡片外观也只属于 Web；
Core 只描述数据，不输出 HTML 或 JSX。

投影函数必须是确定且无副作用的：相同输入得到相同 item 顺序；不得改写输入数组或对象；item
id 与 sortKey 在同一投影内稳定。Core 不依赖 `react`、`react-dom` 或 Web 路径。

### React 宿主：renderer registry

registry 放在独立的 React 包（建议 `packages/agent-react`，包名
`@web-agent/react-plugin`），由每个 React root 创建并持有。它接受 Core 的
`TimelineItem`，将内建类型映射到宿主组件：

```ts
interface TimelineRendererRegistry {
  register<T extends TimelineItem>(
    kind: T['kind'],
    renderer: React.ComponentType<{ item: T }>,
  ): () => void
  resolve(kind: TimelineItem['kind']): TimelineRenderer | undefined
}

function createTimelineRendererRegistry(): TimelineRendererRegistry
```

实际实现应采用对联合类型友好的 overload 或映射类型，不能借 `any` 绕过 item 与 renderer 的
匹配。registry 只存 renderer，不能成为新的 state store、命令总线或权限通道。

宿主先注册并锁定 Core 内建 kind；第三方不能覆盖 user、assistant、tool 等核心记录的展示。
重复注册必须同步拒绝，卸载 disposer 只能注销自己仍持有的注册项。未知 kind 必须走安全的
纯文本 fallback，不执行 payload 中的 HTML、函数或命令。

### 插件安装面的分离

一个发行包可以同时带有 Core 插件和 UI 插件，但它们必须显式分开导出并由各自宿主安装：

```ts
export const corePlugin = definePlugin(/* 工具、hook、受限命令 */)
export const reactPlugin = defineReactPlugin(/* renderer 注册 */)
```

`createCore({ plugins })` 只接收 `corePlugin`；Web 在创建 React root 时向 renderer registry
安装 `reactPlugin`。React 插件不得获得 `CoreInstance`、atom、writer、`ToolContext` 或高权限
命令。需要用户操作时，只能接收宿主明确传入的窄回调 props；v1 不提供通用回调注入。

这也明确否定早期蓝图中把 React `registerRenderer` 放进 `PluginApi` 的设想。那会迫使核心
包的稳定 API 携带 React 类型，并使非 UI consumer 被动耦合前端运行时。

R4 的公开 API 以 `defineReactPlugin` 创建 branded、冻结的插件；其 `install` 只收到
`ReactPluginInstallApi.registerRenderer(kind, renderer)`。实际安装由 React root 调用
`installReactPlugins(registry, plugins)` 完成：注册 token 不返回给插件而由宿主集中追踪，安装中
失败会回滚已注册 renderer，卸载时会先执行插件 disposer，再反序释放全部 renderer token。因而
插件没有 registry 的 `resolve` 能力，也不能遗留注册项。

`@web-agent/plugin-example` 的根入口保留 Core-only 样板，`@web-agent/plugin-example/react`
才导出配对 UI 插件。样板使用现有的 `reasoning` kind，所以只能由明确未锁定该 kind 的宿主安装；
当前 Web App 已锁定全部六个内建 kind，不能以此覆盖其视觉。

## 自定义 item 的延后决策

v1 registry 仅为 Core 已定义的 kind 提供宿主级渲染替换/组合能力，且内建 renderer 由宿主
锁定。它不授权插件注入新的会话项目。

真正的自定义 item 需要另一个版本化协议后才可开放：带 plugin namespace 的 type、JSON
schema/版本、大小限制、持久化与 archive 兼容策略、未知插件的安全 fallback，以及 Web/CLI/server
的一致投影。没有这些约束时，`{ type, payload: unknown }` 会把不受控数据写进会话历史，无法
保证恢复和审计。

## 实施批次

| 批次 | 单一产出 | 验收 |
| --- | --- | --- |
| R1 | Core 纯 `timeline` 投影与单元测试 | 已完成（`846743a`）：不导入 React；项目关联、孤立 result、排序、不可变性与计划阶段投影均已覆盖 |
| R2 | 独立 React registry 与默认 fallback | 已完成（`a2b8d97`）：root 隔离；构造期内建 kind 锁定、重复拒绝、token disposer 与安全纯文本 fallback 均有测试 |
| R3 | 将 Web `MessageList` 拆成投影消费、思考分组、renderer 与虚拟列表 | 已完成（`66072f3`）：每个 App React root 持有独立 registry；六个既有 Core kind 复用原有消息、思考与浏览器卡片视觉；回退动作仍留在列表 shell，未知 runtime kind 仅作纯文本 fallback |
| R4 | `@web-agent/react-plugin` 公开入口及非 React Core 样板配对示例 | 已完成（`79bde78`）：窄 `registerRenderer` 安装面、失败回滚与幂等卸载已测试；样板的 `/react` 子入口不导入 Core 内部模块，卸载后 renderer 无残留 |
| R5 | 另立自定义持久化 item RFC | schema、archive、权限和多 consumer 降级先获批准 |

每批先补失败测试，再以单独、可撤回的 commit 实现。R1 已只抽取目前 `MessageList` 已有的纯
关联逻辑；未改变视觉、工具权限或持久化格式。

## 回归门槛

- 静态检查确认 `packages/agent-core` 及其公开 timeline 入口没有 React 依赖。
- 投影测试覆盖 user、assistant content、reasoning、tool call/result 配对、孤立 result、system
  隐藏、runtime event、browser card 与流式占位。
- React 测试覆盖内建 renderer 锁定、每 root 隔离、重复注册的原子拒绝、未知项 fallback、UI
  插件安装失败回滚、幂等卸载和清理抛错后 renderer 仍释放；payload 不可作为 HTML 注入。
- Web 的消息列表、计划阶段回放和子 Agent 行内展示保持现有可见顺序；必要时由端到端测试回读。
- 每个新增/拆分的源文件遵守单一职责与行数上限；既有超长 `MessageList` 已在 R1 的前置拆分中
  收口，R3 不把新增逻辑继续放入其中。

## 非目标

- 不通过 renderer registry 绕过工具确认、文件/shell 权限或子 Agent 权限。
- 不把 renderer 注册、React context 或 UI atom 加到 `@web-agent/core/plugin`。
- 不在本批修改模型请求、工具执行、会话持久化格式或 Web 的 server-tool 降级策略。
