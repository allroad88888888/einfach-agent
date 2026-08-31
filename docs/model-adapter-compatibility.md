# 模型适配器兼容性契约

本文件记录当前 TypeScript 客户端已经验证的模型差异。它约束 adapter 的编码责任，
不声明供应商 API 的永久能力；升级模型或 API 版本时，必须重新以供应商文档和集成测试
验证。

## 支持范围

| Vendor | 内置模型 | 状态 | 凭证与调用边界 |
| --- | --- | --- | --- |
| `deepseek` | `deepseek-v4-pro`（默认）、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` | 支持 | 仅本机 Node 后端持有 Key 并请求供应商；可传不透明 `user_id`；Vision 保留已验证的图片输入 |
| `glm` | `glm-5.3`（默认）、`glm-5.3-flash` | 支持 | 仅本机 Node 后端持有 Key 并请求供应商；不发送 `user_id`；图片输入尚未审计，不开放 |
| `kimi` | `kimi-k3`（默认） | 支持 | 仅本机 Node 后端持有 Key 并请求供应商；中国区图片上传与 `ms://` 历史引用受 region/凭证 scope 约束 |
| `openai-compat` | 无（协议不含厂商模型，由调用方指定） | 支持 | 仅本机 Node 后端持有 Key 并请求；接入点由用户**显式登记**一条 base URL，端点白名单只放行那一条（见下） |

静态 Web 没有可信模型代理，不能直接请求任一供应商。核心运行时只能构造公共的
`ChatRequestBase`；供应商特有的请求净化、流式 usage 处理和终止语义属于
`packages/agent-ai` 的 adapter。

内置目录恰好是上表六个模型。`Auto` 一律通过省略 `reasoning_effort` 表达，不能作为上游
字面量发送；自定义 `openai-compat` profile 的能力保持未知，不继承官方模型能力。

## 已验证的请求差异

| 项目 | DeepSeek V4 adapter | GLM-5.3 / 5.3-Flash adapter | Kimi K3 adapter |
| --- | --- | --- | --- |
| Thinking / `reasoning_effort` | 可开关；开启时只接受 `low`、`high`、`max` | Thinking 强制开启；只接受 `low`、`high`、`max`，请求始终发送 `thinking:{type:'enabled'}` | Thinking 强制开启；只接受 `low`、`high`、`max`，请求绝不发送 K2.x 的 `thinking` 字段 |
| `thinking: enabled` | 移除 `tool_choice` 与四个采样字段；将纯工具调用轮的空 `content` 规范为 `''` | 原样传递公共请求字段，并强制 `thinking:{type:'enabled'}` | 剥离调用方残留的 `thinking`，保留合法 `reasoning_effort` |
| `user_id` | 只接受长度 1–512 的 `[A-Za-z0-9_-]+` 本地不透明标识 | 不在请求中发送 | 不在请求中发送 |
| 流式 usage | 未显式关闭时写入 `stream_options.include_usage: true` | 不额外写入该字段 | 未显式关闭时写入 `stream_options.include_usage: true` |
| 特有结束状态 | 将 `insufficient_system_resource` 转为可见的重试/中断语义 | 不注入 DeepSeek 特有状态 | 不注入 DeepSeek 特有状态 |

`tool_choice` 的公共类型仍允许 `auto`、`none`、`required` 和指定函数。当前主 Agent
调用路径只发送 `auto`；子 Agent、摘要和低成本提取在无工具时可发送 `none`。因此，
DeepSeek thinking 模式移除 `auto` 不改变默认行为；无工具时移除 `none` 也不会暴露工具。
若将来有生产路径需要 `required` 或指定函数，必须先针对目标模型版本决定：禁用
thinking、拒绝该组合，还是采用供应商提供的其它协议。不得静默沿用当前的降级行为。

## 与 Rust 参考实现的关系

`/Volumes/work/self/einfach-agent-rust` 的 provider 架构表明：模型策略应集中在
provider 的 `encode` / `decode` 边界，而非散落在 Agent 主循环。这与本项目的
`modelAdapter` 方向一致。该项目还实现了 Kimi，并对部分“thinking + 强制工具”组合
采取禁用 thinking 或降级为 `required` 的策略。

这些结论只能作为兼容风险提示，不能直接移植：两边的模型名称、API 版本、会话产品策略
和凭证链路不同。本项目的 Kimi K3 已具备设置项、凭证存储、受限代理与图片链路测试；不得把
该参考实现的 K2.x `thinking` 协议迁回当前 K3 adapter。

## 新增 vendor 的最小准入项

新增供应商是一项跨层产品变更，至少需要同时完成：

1. 在 `agent-ai` 增加独立 adapter，并以测试覆盖请求编码、流式 usage、错误和工具调用历史。
2. 扩展受歧义辨别的模型设置、会话持久化迁移和 UI 选择项，不能以字符串旁路类型系统。
3. 在本机 Node 后端增加 Key 存储和受限请求代理；前端继续不持有 Key。
4. 明确缓存 usage、thinking、`tool_choice` 和模型容量错误的降级语义，并在真实目标模型上回归。
5. 更新用户文档与模型选择测试，确认默认值和已有会话不会被错误迁移。

在上述任一条件缺失时，新增 provider 只能作为设计提案，不能暴露给用户选择。

## openai-compat 准入记录

代码：`packages/agent-ai/src/openaiCompat.ts`（协议实现，`89f8cf8`）、
`packages/agent-ai/src/builtinProviders.ts`（registry 注册，`9129d29`）、
`apps/cli/src/credentials.ts` / `apps/cli/src/runtime.ts`（CLI 接线，同一提交）。

- **协议基线**：标准 `POST <baseUrl>/chat/completions`，一次性与流式两种调用
  （`callOpenAiCompat` / `streamOpenAiCompat`）。公共字段来自 `ChatRequestBase`，只额外
  声明 OpenAI 标准采样参数 `top_p` / `presence_penalty` / `frequency_penalty`，不引入任何
  厂商私有字段（`reasoning_effort`、`region`、`user_id` 都留在各自的 adapter 里）。
- **无厂商净化**：不像 DeepSeek/GLM 那样按 `thinking` 剥采样参数、不归一
  `reasoning_content`、不改写工具调用轮的空 `content`——请求体除图片块投影外原样上行；
  测试覆盖见 `openaiCompat.test.ts` 的「thinking 开启时不做 DeepSeek 式净化」「不归一
  reasoning_content，也不把工具调用轮的 null content 改写成空串」两例。
- **baseUrl 必填**：`requireBaseUrl` 在发出任何请求前校验，缺失或空白字符串一律抛
  `OpenAiCompatConfigError('missing_base_url')`，不回退到任何厂商默认域名；测试覆盖见
  「缺少 baseUrl 时以结构化配置错误拒绝，且一个请求都不发」「空白 baseUrl 与缺失同罪」。
- **`ms://` 泄漏防护**：用户图片块携带的内部 `provider-file` 引用（如 Kimi 上传后的
  `ms://` 编码）经 `nonVisualMessages()` 整体替换为纯文本占位符后才序列化上行，原始
  `reference` 字段不出现在请求体里；测试「结构化用户内容降级为纯文本，且不修改调用方的
  messages」显式断言 `JSON.stringify(captured)` 不含 `'ms://'`。

对照上面「新增 vendor 的最小准入项」五条，openai-compat 目前的完成度：

1. 独立 adapter + 测试覆盖请求编码/流式 usage/错误——**满足**，见上。
2. 模型设置/会话持久化/UI 选择项——**部分满足**：`ModelAdapterSettings` 已加
   `{ vendor: 'openai-compat'; baseUrl?: string }` 分支（`modelAdapter.ts`），但目前没有
   会话级 UI 选择入口，也没有持久化迁移需要处理（尚无历史会话用过这个 vendor）。
3. 本机 Node 后端的 Key 存储与受限请求代理——**满足**：`ModelProviderName`
   （`packages/host-node/src/model/provider.ts`）与前端那一半
   （`apps/web/src/settings/modelCredentialHost.ts`）都已收录第四家，Key 与另外三家同格，
   只由本机后端读写 `~/.webAgent/config.json`。

   **端点白名单在它身上换了一种约束**，这是这一家与另外三家唯一的结构差异：前三家的 origin
   是表里的常量，而 openai-compat 的 baseUrl 由用户填，"精确匹配一个已知 origin"无从谈起。
   替代约束是**显式许可清单**——
   - origin 仍然不来自调用方：信封里只有 `(provider, scope, method, path)`，宿主从
     `~/.webAgent/config.json` 的 `openai-compat:default:baseUrl`（与 CLI 同一个键）读出那条
     用户显式登记的地址；**没登记就是「目标未获允许」**，不存在默认接入点；
   - 登记值本身要过一条结构判据（`packages/host-node/src/model/openAiCompatBaseUrl.ts`）：
     https，或指向回环地址的 http（自建网关的典型形态；明文打到远端等于把 Key 交给链路），
     不许内嵌用户名密码，不许带 query/fragment，长度有上限；
   - 该判据在**写入时**与**每次上行前**各判一次——`config.json` 是用户可以手改的文件，
     不是可信输入；
   - 方法与路径这一维没有放宽：只有 `POST /chat/completions` 一条字面量全等，没有 `/files`、
     没有 DELETE。

   登记入口是 `model_endpoint_status` / `_set` / `_delete` 三条命令（浏览器侧在设置面板的
   模型页）。它们与凭证三条**不合并**：凭证的返回体恒不含 Key，接入点的返回体必须回显地址。
4. 缓存 usage / thinking / `tool_choice` / 容量错误的降级语义——**不适用**：这正是
   openai-compat 刻意不做的部分（见「无厂商净化」），任何该类语义留给具体接入的端点或
   未来的专属 adapter 负责，不在这一层伪装成通用行为。
5. 用户文档与模型选择测试——本节与
   [`docs/launch/comparison.md`](launch/comparison.md) 弱项 3 是这次更新的用户文档部分；
   CLI 侧凭据解析由 `apps/cli/src/credentials.test.ts` 覆盖。

**结论**：openai-compat 是正式的第四家 provider，不是逃生口——CLI 与浏览器两条路都经同一套
凭证存储与受限传输，威胁模型与另外三家一致。它仍然刻意不承诺任何厂商级降级语义（见「无厂商
净化」）：那部分留给具体接入的端点或未来的专属 adapter。
