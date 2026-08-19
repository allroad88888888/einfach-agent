# 图片输入协议 RFC

状态：已实现；功能门禁默认关闭，真实 Kimi Key 联调完成前不开放。
更新时间：2026-08-05。
关联：[模型适配器兼容性契约](model-adapter-compatibility.md)、[Kimi Provider 接入蓝图](kimi-provider-integration-blueprint.md)。

## 1. 目标与边界

本 RFC 只定义图片输入在 UI、Core、模型 adapter 与宿主传输之间的稳定边界。首个落地对象是
Kimi `kimi-k2.6`（用户需求中的“Kimi3”产品代号），但协议不得把 `/v1/files`、
`purpose=image`、`ms://` 等 Kimi 细节泄漏到 Core 或宿主命令中。

目标：

- 纯文本会话保持现有字符串形状与请求行为。
- 带图片的用户轮次以 provider-neutral 内容块持久化，可参与排队、checkpoint、撤回与恢复。
- 每个模型 adapter 自己声明能力、准备图片、编码消息及处理失效引用。
- API Key 始终留在可信宿主；浏览器代码只提交无凭证的通用 provider 请求。
- 图片准备成功前不写入历史；失败或取消后保留草稿。

非目标：

- 不提供一个假设所有模型都能共用的 `uploadImage()` 协议。
- 不让 DeepSeek、GLM 静默接收或丢弃图片。
- MVP 不持久化原图、base64 或 object URL，也不保证重启后仍显示缩略图。
- 静态 Web 产物不直连模型服务，不在前端保存供应商 Key。

## 2. 落地现状

- Core 已兼容旧 `string` 与 provider-neutral 结构化用户内容；队列、checkpoint、恢复、搜索、压缩、
  缓存指纹与标题派生均使用统一投影。
- 宿主侧已从单一 chat proxy 收敛为固定 `(provider, scope, method, path)` 的通用 JSON/multipart 传输；
  adapter 仍独占上传字段、远端引用及响应解析。（这条落地时的宿主是 Tauri 的 Rust 代理；桌面端已随
  T1 删除，今天同一份收窄住在 `packages/host-node/src/model/`。）
- `modelApi.ts` 已成为兼容导出入口，协议、HTTP、SSE、usage 与重试按职责拆分。
- Composer 附件草稿、校验、预览和托盘均为独立模块；原图字节、base64 与 object URL 不进入持久化。
- `VITE_KIMI_IMAGE_INPUT_ENABLED` 默认关闭；没有可信凭证宿主时不展示可用入口。

## 3. 职责边界

| 层 | 必须负责 | 禁止负责 |
| --- | --- | --- |
| Composer | 选择、粘贴、拖放、预览、删除、客户端校验 | 供应商上传协议、持久化远端引用 |
| Core runtime | 提交顺序、事务提交、排队、取消、持久化不变量 | 解析 `ms://`、拼 Kimi multipart |
| Model adapter | model-level capability、图片准备、引用兼容、消息编码 | 读取用户配置文件、决定宿主安全白名单 |
| Web transport | 把通用请求描述映射到本机后端的 `/api/model`（或开发 relay） | 持有 Key、接受任意目标 URL |
| 宿主 transport | 凭证注入、固定 origin/method/path 白名单、限额、超时、取消 | `kimi_upload_image`、`purpose=image`、文件 ID 解析 |
| 持久化层 | 保存短引用与展示元数据 | 保存 `File`、object URL、图片字节或 base64 |

关键边界：**上传是 Kimi adapter 的行为；宿主只是一条安全的通用 provider transport。**
宿主可以为了 SSRF 防护列出允许的方法与路径，但不能给这些路径命名上传/删除业务路由，也不能解析
其供应商字段或远端引用。
未来接入 OpenAI、Gemini 或其它模型时，只新增各自 adapter 的图片策略；仅当现有通用传输形状
无法承载其 HTTP 需求时，才扩展 transport 能力。

## 4. Provider-neutral 契约

以下是目标形状，不要求实现时机械照抄命名：

```ts
type UserTurnInput = {
  text: string
  images: readonly LocalImageDraft[]
}

type UserMessageContent = string | readonly UserContentBlock[]

type UserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        kind: 'provider-file'
        provider: string
        scope: string
        reference: string
      }
      name: string
      mimeType: string
      byteSize: number
      width?: number
      height?: number
    }

type ImageInputCapability =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'provider-upload'; accept: readonly string[]; limits: ImageLimits }
```

`reference` 与 `scope` 对 Core 都是不透明字符串。Core 只能比较、持久化、生成稳定指纹；只有创建
该引用的 adapter 可以判断当前模型、区域或账号是否还能消费它。

Adapter 至少需要覆盖三个阶段：

```ts
interface ModelAdapter {
  capabilities(model: string): ModelCapabilities
  prepareUserTurn(input: UserTurnInput, context: AdapterContext): Promise<PreparedUserTurn>
  encodeMessages(messages: readonly ModelItem[], model: string): readonly ProviderMessage[]
}
```

`prepareUserTurn` 可借助通用 `ProviderTransport` 发 JSON 或 multipart 请求，但 multipart 字段、
上传路径、响应解析与引用格式仍由 adapter 决定。纯文本轮次继续保存为 `string`，避免无关 provider
出现请求形状回归。

## 5. 提交事务与顺序

每个会话使用串行 submission gate；一次提交按以下状态机执行：

```text
draft snapshot
  -> validate complete batch
  -> selected adapter capability check
  -> adapter.prepareUserTurn
  -> all images prepared
  -> atomically append-or-queue durable user item
  -> clear the exact submitted draft
  -> start or continue model run
```

不变量：

- 准备期间 Composer 保持草稿可见，MVP 暂停编辑与再次发送，避免晚到图片被后发文本越过。
- 任一图片失败、引用无效、会话被删除或请求被取消时，历史与队列均不变化。
- 多图可并发准备，但结果必须按用户选择顺序重组；成功一部分后失败时由 adapter 尽力清理孤儿文件。
- 只有全部准备成功后才能一次性提交；提交后持久化的只是引用与元数据。
- 正在运行时的新输入仍进入既有队列，但队列项改为结构化内容并保留 submission sequence。

## 6. 历史兼容与降级

- 旧历史中的 `content: string` 无需迁移；新写入仅在存在图片时使用内容块。
- 标题、搜索、摘要与撤回草稿通过统一的 `userContentText()` 投影读取文本；图片-only 轮次使用稳定的
  “图片对话”标题，不产生 `[object Object]`。
- 缓存指纹必须包含图片引用、顺序、scope 与元数据；不得读取原始图片字节。
- token 预算使用 adapter 提供的保守估算及服务端真实 usage 校准，不复制固定图片 token 常量。
- 切换到不能消费历史引用的模型时，adapter 投影确定性的可见占位文本并产生 UI 警告；绝不能把
  Kimi 引用发送给其它 provider。
- 重启后继续显示附件卡片元数据。由于不持久化原图，缩略图可降级为空，不伪造可用预览。

## 7. 安全与产品限额

MVP 采用比供应商更严格的产品限额：

- 只接受 JPEG、PNG、WebP；最多 8 张，每张不超过 20 MiB，每批不超过 40 MiB。
- 可解码图片的宽高不超过 4096 × 2160；校验 magic bytes 与实际解码结果，不只信任扩展名或 MIME。
- 拒绝 SVG、动画图片、损坏文件与零字节文件；后续扩格式必须单独评估预览、内存和计费影响。
- 图片字节不进入日志、trace、错误文本、历史、checkpoint 或缓存指纹。

宿主通用传输必须：

- 由 `(provider, scope, route)` 映射固定 HTTPS origin、凭证槽与允许的 method/path，不接受任意 URL。
- 支持通用 JSON/multipart body 描述及取消；不解释 multipart 字段含义。
- 分别限制单文件、整包、响应体和超时；禁止重定向，错误中移除 Key、正文与远端敏感字段。
- 开发 relay 执行同等白名单与限额；静态 Web 返回明确“不支持”，不降级为浏览器直连。

## 8. 实现与开放门槛

实现已经满足前五项代码门槛；是否向用户开放仍以第六项真实联调为准：

1. Core 与宿主的职责表无 Kimi 协议泄漏。
2. 提交事务能证明失败不污染历史、排队不乱序、取消可回收。
3. 结构化内容覆盖 hydrate、checkpoint、撤回、恢复、压缩、搜索、标题与缓存指纹。
4. 非视觉模型和不兼容历史引用都有显式、可测试的降级路径。
5. 新建/大改文件遵守单一职责与 300 行上限；存量超限测试不继续追加图片用例。
6. 使用真实中国区 Kimi Key 验证上传、对话、取消、恢复与远端文件清理后，才允许打开功能门禁。
