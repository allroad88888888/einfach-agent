# 自定义持久化 Timeline Item RFC

状态：提议中（R5 产物）；尚未批准，**不对应任何已开放的写入 API 或持久化格式变更**。
更新时间：2026-08-03。

> **§5 的前提已失效（2026-08-17）。** 本 RFC 写作时的会话持久化容器是轮级 `Checkpoint` 与
> `HistoryDriver`；两者已随用户 undo 迁往 einfach 的事务日志（`createHistory`）而整体删除。
> 当前唯一的会话持久化容器是 `RecoverySnapshotV1`，回退语义也不再是
> `jumpToCheckpoint` / `rewindBeforeCheckpoint`。**§5「Checkpoint、存储驱动与回退」在实现前
> 必须按新容器重新推导**，其中提到的表结构迁移、working checkpoint 更新与分支语义均不再适用。
> §1–§4 的 item 形状、资源上限与校验约束不依赖容器，仍然有效。
关联：[插件 UI Renderer 协议](plugin-renderer-protocol-blueprint.md)、[核心运行时流程](core-runtime-flow.md)、[树形子 Agent Runtime](tree-subagent-runtime.md)。

## 1. 问题与边界

R1–R4 的 renderer registry 只处理 Core 已定义的 `TimelineItem['kind']`。插件可以在宿主
允许时替换其视觉，但不能创建新的会话项目。本 RFC 定义后续若要支持“插件产生、重启后仍存在”的
时间线记录时必须遵守的协议；它避免把无约束的 `{ type, payload: unknown }` 写进会话历史。

本 RFC 不做以下事情：

- 不修改 `ConversationItem`、模型请求上下文、工具确认、文件/shell/MCP 权限或子 Agent 权限。
- 不把 React registry、atom、`CoreInstance`、`ToolContext` 或通用 session writer 暴露给插件。
- 不把普通会话扩展自动写入 `.webAgent-archive`；该目录是子 Agent 审计资料的独立通道。
- 不在本 RFC 阶段增加 schema validator、数据库列、迁移脚本、公开插件能力或渲染器。

后续实现只能在本 RFC 的批准项全部满足后，以独立、可回退的提交进行。

## 2. 术语与不变量

- **Core item**：当前 `@einfach-agent/core/timeline` 导出的六种固定 `kind`，仍由 Core 定义与投影。
- **插件持久化 item**：只读、不可变的 JSON 记录；它是 checkpoint 的扩展数据，不是
  `ConversationItem`，也不参与发送给模型的 messages。
- **描述符（descriptor）**：已安装插件为某个 payload 类型声明的 schema 和限制；不是持久化 item
  自带、可执行的代码。
- **未知 item**：当前 consumer 没有匹配描述符、插件未安装或 schema 版本尚不支持的有效记录。
- **隔离（quarantine）**：格式错误或越过资源限额的原始记录。它不可执行、不可渲染、不可进入模型
  上下文，且不能在下一次保存时被静默覆盖或丢弃。

持久化 item 只能追加，不能由插件替换、删除、重编号或改写已存在 item；用户选择 checkpoint
回退时，扩展数据与该 checkpoint 一起回退。写入顺序由 Core 生成的 `createdAt` 和 `sequence` 决定，
不能由插件伪造。

## 3. V1 数据协议

V1 的正式持久化形状如下；所有字段都必须是 JSON 值，不能含 `undefined`、`NaN`、`Infinity`、
函数、日期对象、二进制对象或带自定义 prototype 的对象。

```ts
interface PersistedPluginTimelineItemV1 {
  readonly protocolVersion: 1
  readonly id: string
  readonly createdAt: number
  readonly sequence: number
  readonly plugin: {
    readonly id: string
    readonly itemType: string
    readonly schemaVersion: number
    readonly packageVersion?: string
  }
  readonly payload: JsonValue
}
```

完整类型身份是 `plugin.id/itemType@schemaVersion`，而不是 `packageVersion`。后者只供诊断，不能
用来选择或绕过 schema。规范化后的字段约束如下：

| 字段 | V1 约束 |
| --- | --- |
| `protocolVersion` | 精确为整数 `1`；未知协议版本按未知 item 处理，绝不猜测解析。 |
| `id` | Core 生成，匹配 `pti_[A-Za-z0-9_-]{16,96}`；同一 checkpoint 内唯一。 |
| `createdAt` | Core 写入时生成的安全整数 Unix 毫秒。 |
| `sequence` | Core 在当前 checkpoint 分支内生成的非负安全整数；相同时间按它稳定排序，不能由插件提供。 |
| `plugin.id` | 小写反向域名式 namespace，匹配 `^[a-z][a-z0-9-]{1,62}(?:\.[a-z][a-z0-9-]{1,62})+$`，且禁止 `core.*`、`web-agent.*`。 |
| `itemType` | 插件 namespace 内的类型，匹配 `^[a-z][a-z0-9-]{0,63}$`。 |
| `schemaVersion` | `1`–`10000` 的安全整数；只可为不兼容的 payload 变更递增。 |
| `packageVersion` | 可选 ASCII SemVer 诊断文本，最长 64 字节；不属于信任边界。 |
| `payload` | 由已批准的 JSON Schema Draft 2020-12 描述的纯 JSON 值；不得含文件路径、二进制、HTML 或可执行源码。 |

同一 identity 的 descriptor 至少声明 `schema`、单项 payload 上限和公开的纯文本标题。descriptor
由宿主在插件安装时登记；持久化记录不内嵌 schema，也不允许存档在读取时下载、动态 import 或执行
schema。实际实现必须固定一个支持 Draft 2020-12 的验证器及其版本，并为该验证器的资源消耗设限。

## 4. 限额与验证顺序

V1 的初始硬上限如下；宿主可收紧，不能放宽：单个 payload 16 KiB、完整 item 20 KiB、单个
checkpoint 最多 100 个插件 item 或 256 KiB（以先达到者为准）、单会话在恢复视图中最多 1 MiB。
字节数按 UTF-8 的规范化 JSON 编码计算，递归深度最多 16，任一对象最多 100 个键，任一数组最多
1,000 项，任一字符串最多 8 KiB。超限结果是明确的 `quota_exceeded`，不会截断后落盘。

Core 必须在以下两个方向使用同一套、无副作用的 decoder：

1. **写入前**：验证 capability、当前安装插件身份、identity、JSON 可序列化性、schema、重复 id 与
   所有资源上限；随后由 Core 添加 `id`、`createdAt`、`sequence`，作为 checkpoint 提交的原子组成部分。
2. **读取前**：在 IndexedDB、SQLite 和任何 import/archive reader 取到原始 JSON 后逐项验证；
   单条坏记录进入 quarantine 并生成诊断，不能使整个会话 hydrate 失败或被当成合法数据。

schema 通过只说明“格式可接受”，不授予权限。未知但符合本 envelope 上限的 item 必须原样保留；
无效 item 保留原始字节与失败原因，直到用户显式导出、清除或完成受审计修复，绝不由普通 checkpoint
保存路径自动抹去。

## 5. Checkpoint、存储驱动与回退

V1 的唯一会话真相仍是 checkpoint。经批准后的未来 shape 是可选的附加字段：

```ts
interface Checkpoint {
  // 既有字段不变
  pluginTimelineItems?: readonly PersistedPluginTimelineItemV1[]
}
```

缺少字段的旧 checkpoint 等价于空数组。每个新 checkpoint 保存从当前分支继承的不可变集合加上本轮
新追加的 item；checkpoint 回退恢复目标集合，之后产生的新 checkpoint 自然形成新分支。此策略与当前
`items` 的完整 checkpoint 快照语义一致，不另造一条无法随回退截断的插件日志。实现必须同时覆盖
正常提交、运行中的 working checkpoint 更新、`jumpToCheckpoint`、`rewindBeforeCheckpoint` 与删除/
截断路径，不能只在最终提交时保存该字段。

实现前必须满足以下兼容要求：

- IndexedDB 虽保存整个 checkpoint 对象，仍必须经过上述 decoder；不能信任结构化克隆出来的数据。
- SQLite 当前把 `items` 单列 JSON 化，须先做**只增不删**的迁移，增加可空
  `plugin_timeline_items` 列。`NULL` 表示旧数据的空数组；迁移成功前禁止任何 writer 产生扩展 item。
- SQLite 的 load/save 都要读写该列，且保存旧 checkpoint 时不得清空未知有效 item；SQLite 与
  IndexedDB 对同一 JSON 必须得到相同排序、恢复和 quarantine 结果。
- 迁移必须可重复、可从“没有新列”的数据库启动，且 migration、写入与 checkpoint 元数据更新的
  失败语义可测试。不得以破坏性重建表、静默删历史或整库重写作为升级条件。

本节写作时依赖的 `Checkpoint` 与 `HistoryDriver` 已被删除（见文首说明）；
[`hydrate`](../packages/agent-core/src/state/persistence/hydrate.ts) 今天只投影
[`RecoverySnapshotV1`](../packages/agent-core/src/state/recoverySnapshot.type.ts)，
也没有这一字段。本节是未来变更的约束，且需先按新容器重新推导。

## 6. Archive 与导入导出

`.webAgent-archive/` 保存子 Agent 的 run、events、tree、skills 与索引，并由独立 writer 串行化；它不是
普通会话 history 的镜像。现有 replay 对 `events.jsonl` 的事件类型采用严格白名单，archive reader
还会对 tree/events 分别限制读取 200 KiB；两者都不能复用为插件 item 容器。因此 V1 会话持久化不修改
现有 archive 文件、路径、event 类型或 writer。

若后续单独批准“导出插件 item 到 archive”，必须新增专用的
`timeline-items.jsonl`，每行都为下面的封套，且使用当前 archive 的路径锁与 append 审计规则。逐行格式
保证任一行仍低于现有 200 KiB 读取门槛：

```json
{"archiveVersion":1,"recordType":"plugin_timeline_item","item":{"protocolVersion":1}}
```

具体 `item` 必须是完整的 V1 item，而不是 schema、React props、文件引用或被渲染后的 HTML。读者按
行隔离解析错误：有效未知 item 保留完整 JSON；坏行保留原始行与诊断并跳过展示；重新导出时未经用户
修复的原始坏行只能按原字节转存，不能被“修复性”改写。archive reader 不加载插件代码、不调用
renderer，也不将 payload 输出到默认报告。

## 7. 权限与写入面

R5 不向 `@einfach-agent/core/plugin` 添加任何方法。后续实现只有在宿主显式授予 manifest capability
`timeline.persist` 后，才可在受限 run API 中注入一个专用 `PluginTimelineWriter`。授予前宿主应向
用户展示插件 identity、可持久化的 item identity 和上限，并按 workspace 保存该授权。

该 writer 必须同时满足：

- 只绑定当前 Core 与当前 session；不接收、暴露或允许伪造 `sessionId`、checkpoint writer、atom 或
  任意存储 key。
- 只能 `append(payload)` 到已授权、已安装插件的已登记 identity；Core 自行填入时间、id 与 sequence。没有
  replace、delete、查询其他会话、路径写入或任意 JSON 文档写入能力。
- 不给模型、工具参数、MCP server 或 React renderer 直接访问。插件想响应用户操作，只能由宿主传入
  明确、窄化的回调；不能借此绕过工具确认或现有能力边界。
- capability 被撤销、插件卸载、schema 不匹配、会话只读、配额满或 checkpoint 提交失败时 fail closed，
  返回稳定错误码并给宿主可见提示，不留下半条记录。

这与当前公开插件面只允许安装期 `registerTool`、运行期受限 commands/observers 的原则一致；任何
“给插件状态 writer 以便方便存 item”的方案都被本 RFC 拒绝。

## 8. Consumer 的一致降级

插件 item 先投影为一个 Core 固定 kind（未来可命名为 `plugin-item`），再由宿主按完整 identity 决定
是否使用已登记 renderer；插件不能注册新的 Core kind，也不能覆盖现有内建 kind。未匹配时必须统一
降级为安全的、纯文本元数据视图：`plugin.id`、`itemType`、`schemaVersion`、`id`、`createdAt` 与
“插件或版本不可用”状态。默认视图不得递归展开 payload、解析 Markdown/HTML、使用 `dangerouslySetInnerHTML`
或调用插件代码。

| Consumer | 有 descriptor | 无 descriptor 或未知版本 | 无效/quarantine |
| --- | --- | --- | --- |
| Web | 宿主登记的受限 renderer | 固定纯文本 fallback；不读 payload | 固定错误提示与诊断入口；不读 payload |
| CLI/报告 | schema 验证后的稳定文本摘要 | identity 与不可用状态；默认不打印 payload | 行号/id 与错误码；默认不打印原始数据 |
| server/export API | 返回经过 decoder 的 canonical item | 返回原 envelope 与 `unavailable` 标记，不执行 | 仅受权限保护的诊断/原始导出；不作为正常 timeline 数据 |
| archive/import | 校验后导入 | 完整 envelope 透传，供未来插件恢复 | 原始行隔离保存，禁止自动改写 |

仓库目前没有通用 server consumer 或 timeline CLI；该行是未来 API 的合同，不能据此假设已有服务端
实现。所有 consumer 都不得把 payload 拼进模型请求、遥测、错误日志或默认复制文本。

## 9. 实施前的验收矩阵

批准后必须先有失败测试，再分别交付 codec、checkpoint migration、受限 writer 与 consumer 投影；不可
在一个提交里混合。至少覆盖：

- identity、JSON 结构、递归/键/字符串/字节限额、schemaVersion、重复 id、排序和 `quota_exceeded`。
- 插件只能写自己的 identity 与当前 session；卸载、撤权、坏 schema、失败提交均无残留。
- 旧 checkpoint、SQLite 无列/已迁移列、IndexedDB、同一数据双驱动 round-trip、正常/working checkpoint
  更新、`jumpToCheckpoint`、`rewindBeforeCheckpoint`、删除/截断与分支重写；单条坏 item 不阻断 hydrate
  且不被下次保存删除。
- archive JSONL 的版本、逐行损坏隔离、未知 item 无损透传和原始坏行转存；不得改变现有子 Agent
  archive 的事件/索引行为。
- Web 无 descriptor、恶意 `plugin.id`/payload、renderer 抛错；CLI/报告与未来 API 的默认不泄露
  payload；模型请求快照中不出现插件 payload。
- capability 授予、撤销、跨 workspace/session 隔离，以及工具确认、文件/shell/MCP 权限未被绕过。

## 10. 批准门槛与下一步

开始编码前必须由 Core、持久化、安全和 Web owner 明确批准：JSON Schema validator 与版本、上述默认
限额及隐私策略、`timeline.persist` 的授权 UI/持久化位置、SQLite migration 与 quarantine 保留策略、
archive 导出的独立启用条件，以及四类 consumer 的 fallback 合同。任何一项未批准时，R5 保持“仅 RFC”，
R1–R4 的固定 Core timeline 协议不受影响。

批准后推荐拆分顺序为：纯 codec/descriptor 测试 → Checkpoint/双 driver 的加性迁移 → 受限 writer 与
授权 → Core 投影及 Web fallback → archive/export（若另行批准）。每步单独 commit、通过相关测试与
完整类型检查后再进入下一步。
