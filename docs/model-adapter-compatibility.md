# 模型适配器兼容性契约

本文件记录当前 TypeScript 客户端已经验证的模型差异。它约束 adapter 的编码责任，
不声明供应商 API 的永久能力；升级模型或 API 版本时，必须重新以供应商文档和集成测试
验证。

## 支持范围

| Vendor | 默认模型 | 状态 | 凭证与调用边界 |
| --- | --- | --- | --- |
| `deepseek` | `deepseek-v4-pro` | 支持 | 仅桌面原生层持有 Key 并请求供应商；可传不透明 `user_id` |
| `glm` | `glm-5.2` | 支持 | 仅桌面原生层持有 Key 并请求供应商；不发送 `user_id` |
| `kimi` | — | 未接入 | 不应仅凭另一项目的 provider 代码新增为可选项 |

静态 Web 没有可信模型代理，不能直接请求任一供应商。核心运行时只能构造公共的
`ChatRequestBase`；供应商特有的请求净化、流式 usage 处理和终止语义属于
`packages/agent-ai` 的 adapter。

## 已验证的请求差异

| 项目 | DeepSeek V4 adapter | GLM adapter |
| --- | --- | --- |
| `reasoning_effort` | 只接受 `high`、`max` | 接受 `low`、`medium`、`high`、`max` |
| `thinking: enabled` | 移除 `tool_choice` 与四个采样字段；将纯工具调用轮的空 `content` 规范为 `''` | 原样传递公共请求字段 |
| `user_id` | 只接受长度 1–512 的 `[A-Za-z0-9_-]+` 本地不透明标识 | 不在请求中发送 |
| 流式 usage | 未显式关闭时写入 `stream_options.include_usage: true` | 不额外写入该字段 |
| 特有结束状态 | 将 `insufficient_system_resource` 转为可见的重试/中断语义 | 不注入 DeepSeek 特有状态 |

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
和凭证链路不同。本项目目前既没有 Kimi 的设置项，也没有其原生凭证存储、代理网络白名单、
会话迁移和端到端测试；在这些边界齐备前，Kimi 不是一个可用 vendor。

## 新增 vendor 的最小准入项

新增供应商是一项跨层产品变更，至少需要同时完成：

1. 在 `agent-ai` 增加独立 adapter，并以测试覆盖请求编码、流式 usage、错误和工具调用历史。
2. 扩展受歧义辨别的模型设置、会话持久化迁移和 UI 选择项，不能以字符串旁路类型系统。
3. 在桌面原生层增加 Key 存储和受限请求代理；Web 继续不持有 Key。
4. 明确缓存 usage、thinking、`tool_choice` 和模型容量错误的降级语义，并在真实目标模型上回归。
5. 更新用户文档与模型选择测试，确认默认值和已有会话不会被错误迁移。

在上述任一条件缺失时，新增 provider 只能作为设计提案，不能暴露给用户选择。
