# Kimi Provider 接入蓝图

状态：代码实现与静态独立审查完成；缺少真实 Kimi 中国区 Key，开放结论为 **NO-GO**。Issue 仅在本文档维护，不创建远端 Issue。
更新时间：2026-08-05。
关联：[图片输入协议 RFC](image-input-rfc.md)、[模型适配器兼容性契约](model-adapter-compatibility.md)。

## 1. 目标形态

用户需求中的“Kimi3”按产品代号保留；截至 2026-08-05，官方模型列表没有 `kimi-k3` API ID，
首期实际接入当前可调用的多模态模型 `kimi-k2.6`。它支持纯文本、工具调用、thinking、多轮历史与
图片输入。会话层 vendor
仍为 `kimi`；endpoint region 是显式设置，默认 `cn`，`chat/completions` 与 `files` 必须使用同一
region 和凭证 scope。全球区只有在真实 Key 烟测通过后才开放选择。

Kimi adapter 独占以下知识：

- `POST /v1/files`、multipart `purpose=image` 与上传响应解析。
- 把远端文件 ID 封装为 `ms://...`，并编码为 `image_url` 内容块。
- `kimi-k2.6` 的 model-level 图片 capability、`thinking` 与消息历史规则。
- 文件失效、账号/region 不兼容、部分上传失败时的错误与清理语义。

Tauri 只实现 [图片输入协议 RFC](image-input-rfc.md#3-职责边界) 中的通用安全传输，不新增
`upload_kimi_image`、`model_image_upload` 等供应商业务命令。宿主只按
`provider/scope/method/path` 执行精确安全白名单；请求路径的业务含义、multipart 字段与响应解析仍由
adapter 独占。

## 2. 已验证的 Kimi 契约

- 中国区 base URL：`https://api.moonshot.cn/v1`；全球区：`https://api.moonshot.ai/v1`。
- 图片上传使用 `/files`，multipart 字段为 `purpose=image` 与 `file`。
- 带图消息使用内容数组，图片项为 `image_url.url = ms://<file-id>`；不支持公网图片 URL。
- `kimi-k2.6` 默认启用 thinking；用顶层 `thinking.type = enabled | disabled` 切换，不发送
  `reasoning_effort`。
- 多轮必须保留 assistant 的 `reasoning_content`、`tool_calls` 与对应 tool results。
- 固定采样参数不主动发送，避免把其它 provider 的默认参数误投给 Kimi。

实现时重新核对官方资料：[K2.6 Quickstart](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)、
[视觉输入指南](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)、
[Files API](https://platform.kimi.ai/docs/api/files-upload) 与
[模型列表](https://platform.kimi.ai/docs/models)。

## 3. 执行模型分配

这里的“模型”指执行 Issue 的 Codex 模型，不是应用接入的 Kimi 模型。

| 模型 | 默认推理档位 | 使用范围 |
| --- | --- | --- |
| `gpt-5.6-sol` | high | 跨层契约、Core 事务、供应商协议、Rust 安全边界、真实联调 |
| `gpt-5.6-terra` | medium | 有清晰接口的设置、UI、开发 relay、文档实施 |
| `codex-auto-review` | high | 特征测试、回归矩阵、无障碍、安全与最终独立审查 |

每个 Issue 只有一个主执行模型。需要复核时另开 review Issue，避免“实现者自证”。

## 4. 树形 Issue

```text
KIMI-IMG  Kimi（kimi-k2.6）+ 图片输入交付                [gpt-5.6-sol]       [NO-GO]
├─ KIMI-00  契约与回归基线                              [gpt-5.6-sol]       [完成]
│  ├─ KIMI-00A  冻结 RFC、region 与产品限额             [gpt-5.6-sol]       [完成]
│  ├─ KIMI-00B  固化 DeepSeek/GLM 纯文本特征测试         [codex-auto-review] [完成]
│  └─ KIMI-00C  按职责拆分超限 modelApi                 [gpt-5.6-sol]       [完成]
├─ KIMI-10  Provider 基础设施                           [gpt-5.6-sol]       [完成]
│  ├─ KIMI-10A  扩展 vendor、settings 与 model capability [gpt-5.6-sol]       [完成]
│  ├─ KIMI-10B  凭证设置改为 provider/region 驱动        [gpt-5.6-terra]     [完成]
│  ├─ KIMI-10C  定义 Web 通用 ProviderTransport          [gpt-5.6-sol]       [完成]
│  ├─ KIMI-10D  实现 Tauri 白名单 JSON/multipart 传输    [gpt-5.6-sol]       [完成]
│  └─ KIMI-10E  对齐开发 relay 与静态 Web 降级           [gpt-5.6-terra]     [完成]
├─ KIMI-20  Kimi adapter                                [gpt-5.6-sol]       [完成]
│  ├─ KIMI-20A  接入文本、stream、thinking 与工具历史    [gpt-5.6-sol]       [完成]
│  ├─ KIMI-20B  在 adapter 内实现图片准备与上传          [gpt-5.6-sol]       [完成]
│  ├─ KIMI-20C  编码多模态消息与验证引用 scope           [gpt-5.6-sol]       [完成]
│  └─ KIMI-20D  建立 adapter 协议测试矩阵                [codex-auto-review] [完成]
├─ KIMI-30  Core 提交事务                               [gpt-5.6-sol]       [完成]
│  ├─ KIMI-30A  引入 provider-neutral 用户内容           [gpt-5.6-sol]       [完成]
│  ├─ KIMI-30B  实现准备后原子提交与会话顺序门           [gpt-5.6-sol]       [完成]
│  ├─ KIMI-30C  统一历史文本、指纹与 token 投影          [gpt-5.6-sol]       [完成]
│  └─ KIMI-30D  覆盖持久化、checkpoint 与恢复测试        [codex-auto-review] [完成]
├─ KIMI-40  Composer 与消息展示                         [gpt-5.6-terra]     [完成]
│  ├─ KIMI-40A  建立 Einfach 附件草稿 atoms/actions      [gpt-5.6-terra]     [完成]
│  ├─ KIMI-40B  实现选择、粘贴、拖放与附件托盘          [gpt-5.6-terra]     [完成]
│  ├─ KIMI-40C  实现历史附件卡与模型切换警告             [gpt-5.6-terra]     [完成]
│  └─ KIMI-40D  覆盖 UI、object URL 与无障碍测试         [codex-auto-review] [完成]
└─ KIMI-50  集成与开放门禁                              [codex-auto-review] [部分完成]
   ├─ KIMI-50A  桌面真实 Key 端到端联调                  [gpt-5.6-sol]       [阻塞]
   ├─ KIMI-50B  安全、回归与文件职责独立审查             [codex-auto-review] [静态审查完成；最终验收受 50A 阻塞]
   └─ KIMI-50C  更新正式文档并执行 go/no-go              [gpt-5.6-terra]     [完成：NO-GO]
```

## 5. Issue 明细

| Issue | 依赖 | 主交付物 | 完成判据 |
| --- | --- | --- | --- |
| KIMI-00A | — | 批准 RFC；确认 `cn` 默认、global 开放门槛、MVP 限额 | 所有跨层接口与失败语义无开放项 |
| KIMI-00B | — | DeepSeek/GLM 请求、SSE、usage、retry characterization tests | 重构前后请求与流结果等价 |
| KIMI-00C | 00B | 将 `modelApi.ts` 拆为类型、HTTP、SSE、retry 单职责模块 | 入口兼容；新文件均不超过 300 行 |
| KIMI-10A | 00A, 00C | `kimi` settings、`kimi-k2.6` descriptor、model-level 图片 capability | 未知模型保守降级；旧 session 可 hydrate |
| KIMI-10B | 10A | provider/region 参数化 credential host、atoms、commands、设置面板 | 前端永不回读 Key；DeepSeek 行为不变 |
| KIMI-10C | 00A, 00C | 通用 JSON/multipart `ProviderTransport` 契约及 Tauri bridge | adapter 不依赖 Tauri；不接受任意 URL |
| KIMI-10D | 10B, 10C | Rust provider method/path allowlist、凭证注入、multipart、取消与限额 | Rust 中没有 provider 文件业务路由或命令；重定向和越权路径被拒绝 |
| KIMI-10E | 10B, 10C | 开发 relay 等价传输；静态 Web 明确不可用 | relay 不接收浏览器 Key，白名单与限额可测 |
| KIMI-20A | 10A, 10C | Kimi call/stream adapter、thinking/tool history 编码与 usage 归一化 | 纯文本、工具续轮、尾帧 usage 测试通过 |
| KIMI-20B | 10C | adapter 内 `/files` multipart、批量准备、顺序恢复与尽力清理 | 代码外无 `purpose=image`；部分失败不返回半成品轮次 |
| KIMI-20C | 10A, 20A, 20B | `ms://` 封装、内容数组编码、scope/模型可消费性判断 | Kimi wire 顺序正确；外部 provider 看不到 Kimi 引用 |
| KIMI-20D | 20A–20C | 独立 Kimi adapter 测试文件 | text-only、image-only、多图、错误、abort、历史工具轮全覆盖 |
| KIMI-30A | 10A | 结构化用户内容、队列/checkpoint/persistence 兼容读写 | 旧字符串零迁移；引用经重启与撤回不丢失 |
| KIMI-30B | 20B, 30A | per-session submission gate、准备后原子 commit、取消与草稿回滚 | 失败历史零变化；慢图片不被后发文本越过 |
| KIMI-30C | 30A | title/search/preview/compaction/token/fingerprint 集中投影 | 无 `[object Object]`；指纹含引用顺序；无固定图片 token 常量 |
| KIMI-30D | 30B, 30C | focused runtime/persistence tests | queue、checkpoint、revert、withdraw、hydrate、模型切换全部通过 |
| KIMI-40A | 10A | Einfach 附件 draft atom、派生状态、写 actions、object URL 生命周期 | 不引入 React 本地产品状态；移除/销毁时释放 URL |
| KIMI-40B | 30B, 40A | picker、paste、drop、预览、删除、校验与 preparing 状态 | 图片-only 可发；错误保留草稿；发送期间不会重复提交 |
| KIMI-40C | 20C, 30A | 持久化附件卡、重启降级、非视觉/异 scope 警告 | 不静默丢图；不可消费引用不会进入 provider wire |
| KIMI-40D | 40B, 40C | focused UI 与无障碍测试 | 键盘、错误提示、预览清理、模型切换和 8 图边界通过 |
| KIMI-50A | 10D, 10E, 20D, 30D, 40D | 桌面装配与真实 Kimi Key dogfood 记录 | 单图、多图、追问、工具轮、取消、重启、region 均实测 |
| KIMI-50B | 50A | 独立安全/回归审查与全量检查 | 无 Key/图片日志泄漏；DeepSeek/GLM、lint、typecheck、Rust tests 全绿 |
| KIMI-50C | 50B | 更新兼容矩阵、根 README、`CLAUDE.md` 与文档状态 | 仅在证据齐全时开放 Kimi 选择；否则保持 feature gate 关闭 |

## 6. 并发批次

| 批次 | 可并行 Issue | 合并门槛 |
| --- | --- | --- |
| B0 | 00A, 00B | RFC 与现有文本基线确定 |
| B1 | 00C | `agent-ai` 职责拆分稳定 |
| B2 | 10A, 10C | capability 与 transport 公共契约编译通过 |
| B3 | 10B, 20A, 20B, 30A, 40A | 各层可用 mock 独立验证 |
| B4 | 10D, 10E, 20C, 30B, 30C | Kimi 准备结果可进入 Core 事务 |
| B5 | 20D, 30D, 40B, 40C | adapter、runtime 与 UI 主路径完成 |
| B6 | 40D | UI 回归与无障碍矩阵完成 |
| B7 | 50A | 桌面真实 Key 联调证据齐全 |
| B8 | 50B | 独立安全与回归审查通过 |
| B9 | 50C | 文档完成并作出 go/no-go 决策 |

并行 Issue 不得共享主文件。`main.tsx`、Rust `lib.rs` 与公共 export 的最终装配统一归 KIMI-50A，
避免基础设施 Issue 相互覆盖；任何新测试写入独立 focused 文件，不向已有超限测试继续追加。

## 7. Go / No-go

满足以下条件才把 Kimi 从“未接入”改为“支持”：

1. 真实 `cn` Key 完成 files + chat 同 region 验证；global 未验证时不展示。
2. 图片上传失败、取消、会话删除与模型切换均不会污染历史或泄漏引用。
3. Rust route 白名单、无重定向、凭证隔离、正文限额与日志脱敏审查通过。
4. DeepSeek/GLM 的纯文本、工具调用、缓存 usage 与重试基线无回归。
5. 新建/大改文件符合单一职责与行数硬规则，文档链接检查通过。

### 当前决策

2026-08-05 结论为 **NO-GO**：KIMI-00 至 KIMI-40 已实现，KIMI-50B 静态独立审查发现的
在途上传回滚竞态、上游错误回显、功能门禁绕过、Global 回收不对称与跨宿主信封限额差异均已修复；
adapter 的上传 origin 也固定为官方中国区端点，不接受调用方覆盖；
最终验收仍依赖 KIMI-50A，但当前无真实中国区 Key，
未能对真实 Files + Chat、取消、追问、工具轮、重启恢复与远端删除执行 dogfood。
`VITE_KIMI_IMAGE_INPUT_ENABLED` 继续保持 `false`，不展示 Kimi 入口。

已实现的边界可从 [Kimi adapter](../packages/agent-ai/src/kimiFiles.ts)、
[Core 提交事务](../packages/agent-core/src/runtime/preparedUserInputTransaction.ts)、
[Web 通用传输](../apps/web/src/modelTransport/providerWireEnvelope.ts) 与
[Rust 通用传输](../apps/desktop/src/model_proxy_envelope.rs) 回读。远端文件清理是 adapter 所有的
best-effort 行为；应用崩溃、凭证更换或供应商删除失败仍可能留下孤儿文件，开放前需在真实联调中记录和接受该剩余风险。
