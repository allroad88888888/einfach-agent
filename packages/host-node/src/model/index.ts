// model 域的 registrar：受限模型传输（provider 请求转发与取消）
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 config/index.ts）。域内分层照搬 Rust 侧同一套：
//   provider.ts           ← model_provider.rs        供应商/作用域枚举与配对表
//   providerRoute.ts      ← model_provider_route.rs  **端点白名单**（本域安全性的全部）
//   wireShape.ts          ← serde deny_unknown_fields 三处收窄共用的形状判据
//   requestBody.ts        ← model_proxy_body.rs      请求体收窄与限额
//   multipartEncoding.ts  ← reqwest::multipart       分片编码（Node 侧没有现成件）
//   requestEnvelope.ts    ← model_proxy_envelope.rs  信封收窄与 56 MiB 硬顶
//   requestRegistry.ts    ← model_request_registry.rs 在飞请求表（取消的落点）
//   credentialSection.ts  ← model_credential_config.rs `modelCredentials` 段视图
//   credentials.ts        ← model_credentials.rs     (供应商,作用域)→配置键→明文 Key（读取半边）
//   upstreamRequest.ts    ← model_proxy_http.rs      真正那一次 HTTP 往返 + 流式透传
//   forwardRequest.ts     ← model_proxy.rs           编排
//   cancelCommands.ts     ← model_proxy.rs 的两条 cancel 命令
//
// ═══ 本域路由表里为什么只有两条命令 ═══
// commandNames.ts 给 model 域登记了七条。它们分三批，落在三张卡上：
//
//   ① `model_provider_request` / `model_chat_completions` —— **故意不在路由表里**。
//      它们的响应是一条流，而路由表 handler 的返回值要经 `POST /api/invoke/:command` 被
//      `JSON.stringify`。写一个「攒完再返回」的 handler 会造出「看起来能流式」的假象（开发机上
//      响应快，根本看不出来）。缺席在类型上就是键不存在，分发层据此报「尚未实现」——那是**准确**
//      的答复。真正的出口是本域导出的 `forwardProviderRequest`：M2 的
//      `POST /api/model/request` 直接调它并把字节 pipe 进 HTTP 响应（M2 判据明写「不进
//      `/api/invoke/:command` 的统一路由」）。详见 forwardRequest.ts 的文件头。
//      `model_chat_completions` 另有一层：那是 Rust 侧给旧渲染层留的兼容命令，**全仓零 TS 调用方**，
//      施工须知把它的实现优先级排在最低。将来要接，它只是把
//      `{provider, body, requestId}` 拼成规范信封（`scope: 'default'`、`POST /chat/completions`）
//      再走同一条路——注意那条兼容路径**够不着 Kimi**，因为 Kimi 只有 `cn` 作用域。
//
//   ② `cancel_model_provider_request` / `cancel_model_chat_completions` —— 就在下面。它们是
//      「一次调用一个布尔值」，`HostInvoke` 的签名装得下。
//
//   ③ `model_credential_status` / `_set` / `_delete` —— **归 M4**（issue 树的改动面明写「host-node
//      侧补这三个命令」）。本卡只落 Key 的**读取**半边，因为转发要用；写入半边连同三条命令由 M4
//      加在 credentials.ts 已经导出的 `credentialConfigKey` / `normalizeApiKey` 之上。
//      两张卡各写一份绑定表必然分叉，所以缝留在那两个导出上。
//
// ═══ 这一域的红线 ═══
// 用户的模型 API Key 只在两处出现：`credentials.ts` 里从配置读出来的那个局部变量，和
// `upstreamRequest.ts` 里的 Authorization 头。它不进返回值、不进错误文案、不进日志——本域**全域
// 没有任何日志语句**，这是有意的。`forwardRequest.test.ts` 里有一条用例正面钉这件事。

import { createCancelModelRequestHandler } from './cancelCommands'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'

export function createModelRoutes(_options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    // 两条命令在 Rust 侧是逐字相同的两个函数，共用同一张在飞请求表。Node 侧同样：
    // 默认参数就是进程级共享的 `modelRequestRegistry`，而 `forwardProviderRequest` 用的也是它。
    cancel_model_provider_request: createCancelModelRequestHandler('cancel_model_provider_request'),
    cancel_model_chat_completions: createCancelModelRequestHandler('cancel_model_chat_completions'),
  }
}

// M2（server 的流式模型端点）要用的东西从这里出去。`createNodeHostInvoke` 之外还有一条调用路径，
// 是本域与其余十几个域**唯一**的形状差别，理由见上面「本域路由表里为什么只有两条命令」。
export { forwardProviderRequest } from './forwardRequest'
export type { ForwardProviderRequestDeps, ForwardedModelResponse } from './forwardRequest'
export { ModelProxyStreamError, ModelRequestCancelledError } from './errors'
export { modelRequestRegistry, createModelRequestRegistry } from './requestRegistry'
export type { ModelRequestRegistry } from './requestRegistry'
export type { ModelFetch } from './upstreamRequest'
