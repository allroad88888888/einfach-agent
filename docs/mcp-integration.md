# MCP 集成

本文描述 Web Agent 当前的 MCP（Model Context Protocol）接入边界、生命周期与安全约束。
实现由三层组成：

1. `tools/mcp`：协议客户端、连接管理与远端工具适配；
2. `apps/desktop/src/mcp.rs`：Tauri 桌面端的 stdio 子进程与 JSON-RPC 会话；
3. `apps/web/src/mcp` 与设置中心：配置持久化、状态展示和用户操作。

应用入口负责把 MCP 管理器装配到默认 `toolRegistry`。UI 只读取 Einfach atom 并调用命令，
不直接访问 registry 或传输层。

## 一期支持范围

| 能力 | Streamable HTTP | stdio |
| --- | --- | --- |
| 运行环境 | 浏览器与 Tauri；浏览器仍受服务端 CORS 约束 | 仅 Tauri |
| 会话持有者 | 官方 TypeScript SDK | Rust/Tauri 后端 |
| `initialize` / `initialized` | 支持 | 支持 |
| `tools/list` / `tools/call` | 支持 | 支持 |
| 工具列表变更 | 收到通知后重新对账 | 收到通知后重新对账 |
| `resources` / `prompts` | 未支持 | 未支持 |
| 用户操作 | 连接、注销、重连、删除 | 连接、注销、重连、删除 |
| 鉴权 | 仅无凭据、无查询参数的基础 URL | 不提供环境变量或凭据字段 |

一期没有凭据保险库：配置字段会以明文写入浏览器 `localStorage`，因此表单不提供 OAuth
token、请求头或进程环境变量字段，并拒绝带查询参数的 URL 与常见凭据形态的启动参数。
这类识别只是防误填，不是秘密扫描器；任何连接字段都不应填写凭据。需要认证的远端
MCP 应在后续接入系统凭据存储与 OAuth 授权流程后启用。

### 协议协商与能力边界

MCP 本身不等于 tools。协议把 `tools`、`resources` 和 `prompts` 定义为不同的服务端
primitive，并在 `initialize` 返回的 capabilities 中分别协商。本项目一期刻意只实现 tools，
不能把 resources 或 prompts 伪装成工具，也不能在没有声明 tools capability 时继续连接。

桌面 stdio 客户端当前只支持 MCP `2025-11-25`：服务端必须选择这一版本、返回 object 型
`capabilities`，并声明 object 型 `capabilities.tools`。版本不受支持、能力缺失或形状错误都会
断开并卸载工具。Streamable HTTP 由官方 TypeScript SDK 完成初始化协商。

每个 `tools/list` 项都必须提供根 `type: "object"` 的 `inputSchema`；缺失、数组、null 或其他
根类型会被拒绝，不会补成一个看似可调用的空 schema。本项目尚未实现 MCP Tasks，因此
`execution.taskSupport: "required"` 的工具同样 fail-closed；它不会被降级成普通
`tools/call`。

## 配置与运行状态

配置是可持久化的数据，连接是进程内的瞬时状态，两者必须分开：

- HTTP 配置保存服务名与 URL；
- stdio 配置保存服务名、命令、参数与工作目录；
- 浏览器持久化不可用时退化为内存存储，设置中心会明确提示刷新或关闭页面后配置丢失；
- 设置中心最多保存 50 个服务；超限配置会明确报错，不做静默截断；
- 连接状态、错误、远端工具定义和活动 client 不持久化；
- 启动恢复配置后，只有显式开启自动连接的 HTTP 服务会异步连接，失败只更新该服务状态，
  不阻断主应用渲染；
- stdio 配置恢复后始终保持未连接，必须由用户在当次桌面应用会话中手动点击“重连”。

### JSON 导入

设置中心支持常见的 `mcpServers` 格式，可以一次导入一个或多个服务：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}
```

也支持带 `name` 的单服务对象：

```json
{
  "name": "playwright",
  "command": "npx",
  "args": ["@playwright/mcp@latest"]
}
```

导入遵循以下约束：

- JSON 文本按 UTF-8 计算最多 256 KiB；设置中心最终最多保存 50 个服务；
- 批量导入是原子的：整批会先完成解析、字段校验、名称冲突与数量校验，再一次持久化；
  任一项失败或持久化失败时均不添加任何服务；
- stdio 服务仅接受 `command`、`args`、`cwd`、`type` 和 `transport`；HTTP 服务仅接受
  `url`、`type` 和 `transport`；单服务格式另外要求 `name`；
- `command` 自动推断为 stdio，`url` 自动推断为 Streamable HTTP；可选的 `type` 或
  `transport` 只能用于显式声明与推断结果相同的传输方式；
- 严格拒绝 `env`、`headers`、`token`、`autoConnect` 以及其他未支持字段，不会静默丢弃；
- 导入只保存配置，所有导入项统一保持未连接，不会启动本地进程或发起网络请求；
- 浏览器可以保存 stdio 配置，但无法启动它；需要在桌面端重新导入或配置同一服务，再手动点击“重连”。浏览器与桌面端配置不会自动同步。

状态流转为：

```text
disconnected ── connect/reconnect ──> connecting ──> connected
      ▲                                  │              │
      └──────── disconnect/error <───────┴──────────────┘
```

“注销”关闭当前连接并卸载该服务的全部动态工具，但保留配置；“重连”先关闭旧会话，
再建立新会话并以新工具列表对账；“删除”先注销，再删除配置。设置服务按 server ID
串行执行这些操作，避免删除与重连交错后把配置或连接复活。任一步骤失败都不能留下一个
UI 显示已断开、registry 却仍可调用的幽灵工具。

每次 stdio 连接还会生成独立的会话令牌。Rust 后端对列举、调用和注销命令校验该令牌，
生命周期事件也携带同一令牌；旧进程迟到的关闭通知、工具变更通知或取消后的清理请求
因此不能误伤随后建立的新会话。服务关闭期间存在 tombstone，不能以同一 ID 提前启动
替代进程；已经使用过的令牌也不会再次接受。

## 工具适配

远端工具注册到本地 registry 时使用稳定命名：

```text
mcp__<server-id>__<remote-tool-name>
```

显示名可以变化，`server-id` 用于隔离同名服务，远端工具名用于在 `tools/call` 中还原调用。
`inputSchema` 经过 JSON 形状校验与防御性克隆后作为本地懒加载 schema；单个 schema
限制为 128,000 字符、32 层和 4,000 个节点，避免不可信服务用极深或超大定义拖垮
递归校验器。远端文本、图片、音频、资源链接或结构化内容作为规范化结果返回给模型，
不在适配层猜测业务语义；单次模型可见结果限制为 1,000,000 字符、64 层和 20,000
个节点，传输私有的 `_meta` 不进入模型上下文。真实错误返回 `ok: false`；已经成功执行
但输出非法或超限时返回固定的 `ok: true` 丢弃标记，明确提醒模型不要仅为取回输出而
重试可能非幂等的工具。

每次连接、重连或收到 `tools/list_changed` 后，管理器都执行集合对账：

- 新增工具注册；
- 同名工具覆盖为最新 schema/描述；
- 内容等价的同名工具复用原注册及版本，忽略对象键顺序和仅影响 UI 的标题变化；
- 已移除工具从 registry 注销；
- 连接关闭时注销该服务命名空间下的全部工具。

`tools/list_changed` 采用 single-flight：突发通知最多保留一次正在执行的刷新和一次 dirty
刷新。注销、重连、删除或异常关闭会取消旧刷新，迟到结果不能重新挂回工具。真正发生
schema、描述或执行约束变化时才签发新注册版本；旧版本的待确认或在途调用会被原子拒绝，
要求模型重新加载 schema。

工具调用沿用现有 `AbortSignal`。取消后客户端应中止请求；非取消异常转换为普通
`ToolResult` 错误，让模型循环可以继续处理。

## 模型投影、延迟加载与 DeepSeek 缓存

MCP 连接只负责发现和调用远端能力。`tools/list` 得到的定义会被适配为本地
`mcp__<server>__<tool>`，进入与内置工具相同的 `ToolRegistry`。发送给 DeepSeek 时，它们
仍是 Chat Completion 顶层 `tools` 数组中的标准 function tool；本项目不发送单独的
`mcp_servers` 字段，也不发送 MCP 专属 content block。

延迟加载规则与内置工具一致：

1. 初始 manifest 只包含名称、简述和 runtime，不预加载第三方 schema 或 guide；
2. 模型通过 `request_tool_schema` 按需加载完整定义；
3. 单次请求最多暴露 128 个 function tools，其中 loader 固定占 1 个，因此业务工具最多
   127 个；
4. manifest 默认返回 16 项、单页最多 32 项，并用目录指纹校验分页 cursor；
5. 可见工具按名称排序，JSON schema 的对象键确定性排序，工具集合指纹不受注册顺序影响。

DeepSeek 的上下文缓存由服务端自动按完整请求前缀命中。本项目不创建、保存或发送
`cache_id`；每轮仍发送完整 system、有效消息历史和当前完整可见 tools。本地 cache tracker
只记录诊断 profile/epoch，真实命中以 DeepSeek usage 尾包中的
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 为准。

固定 system、确定性工具排序与“空变更不换注册版本”可以保持前缀稳定。按需加载新 schema、
工具真实变更、重连或注销会按正确性要求改变 tool profile；新形态稳定后再由 provider
复用，不能为了表面命中率继续发送过期工具。

## 安全边界

MCP 服务是应用之外的信任域。首版采用保守策略：

- 所有 `mcp__*` 调用都标记为危险操作，即使会话处于 Auto 模式也逐次展示参数并等待确认；
- 第三方 `description`、schema 和工具名只用于模型提示，不作为授权依据；
- 注销与连接异常会立即卸载工具，避免继续调用失效或来源已变化的能力；
- 浏览器不保存 token；桌面端不把 stdio 环境变量开放给设置表单；
- Streamable HTTP 在 SDK 解析前限制响应：非 SSE 整个响应最多 4 MiB，SSE 每个事件
  最多 4 MiB；声明长度和实际分块流量都会校验；
- stdio 会启动本地进程，因此其 `autoConnect` 持久化值会被强制清除，不能由
  `localStorage` 或历史配置在应用启动时触发命令；
- 子进程 stderr 被持续消费但不混入 JSON-RPC stdout，也不序列化进 Tauri 返回值、
  前端错误或模型上下文；
- stdio 请求有超时，退出时执行会话清理与子进程终止。

后续如果引入服务级信任、只读工具或“始终允许”，必须基于可审计的服务身份、
能力快照和细粒度权限，而不是匹配名称或自然语言描述。

## 后续演进

建议按以下顺序扩展：

1. OAuth 2.1 + PKCE、系统钥匙串与 token 刷新；
2. Streamable HTTP 会话恢复、服务端事件与更完整的通知订阅；
3. resources、prompts 与 elicitation 等非工具能力；
4. 服务级权限、审计记录、schema 变更提示与调用速率限制；
5. 签名配置导入、企业策略与管理员允许列表。
