// 浏览器这一侧记着的那条 openai-compat 接入点
// ---------------------------------------------------------------------------
// ═══ 这里**不是**判据所在 ═══
// 「一条 base URL 凭什么能用」由本机 Node 后端回答（`packages/host-node/src/model/
// openAiCompatBaseUrl.ts`），本文件不持有那条判据的副本，也不该持有：
//   · 真正决定上行到哪的是后端的端点白名单。浏览器发出去的目标里**没有 origin 字段**，
//     它只能给 (provider, scope, method, path)，所以前端判得再严也改变不了目标，判得再松
//     也扩大不了目标。前端多一份判据只多一处会与后端分叉的地方，而分叉的症状是
//     「面板说存好了、请求却被后端判成目标未获允许」。
//   · 这里存的值来自 `model_endpoint_status` / `_set` 的返回体，**已经是后端归一化过的那条**。
//
// 那前端为什么还要记住它？两件事，都不是安全判定：
//   ① agent-ai 的 openai-compat adapter 必须拿到一个 baseUrl 才肯发请求（缺了就抛
//      `OpenAiCompatConfigError{missing_base_url}`，在任何 fetch 之前）。那条 URL 决定的是
//      adapter 拼出来的**请求 URL 长什么样**，而不是它最终打到哪。
//   ② `providerRoute.ts` 要把 adapter 拼出来的 URL 认回成一个 `ProviderTarget`（剥掉 origin，
//      只留 path）。认不出来就是「目标未获允许」——**没登记时 openai-compat 在前端就发不出去**，
//      与后端同向 fail closed。
//
// ═══ 为什么烘焙进 adapter，而不是塞进每个会话的 vendorSettings ═══
// 与 `apps/cli/src/runtime.ts` 的 `configureOpenAiCompatBaseUrl` 同一条路子：registry 的
// 「重复注册以最后一次为准」让装配层可以换掉零配置的默认实例。走 vendorSettings 的话，
// 每个已存在的会话都得回填一遍 baseUrl，而用户改登记之后老会话会继续用旧地址——那不是
// 「登记」该有的语义。per-request 的 `settings.baseUrl` 仍然优先，覆盖能力没有被拿掉。

import {
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
} from '@einfach-agent/ai'

let registeredOrigin: string | undefined

/**
 * 当前登记的接入点；没登记时是 `undefined`。
 *
 * 刻意做成模块级单值而不是 atom：它的读者是 `providerRoute.ts`（一个纯查表函数，不在 React 里）
 * 与 adapter 装配，两者都不订阅界面状态。设置面板要显示的那份状态另有 atom
 * （`settings/modelEndpointState.ts`），两者由同一条命令一起更新。
 */
export function openAiCompatOrigin(): string | undefined {
  return registeredOrigin
}

/**
 * 应用一条登记（`undefined` = 撤销登记）。
 *
 * 撤销时把 adapter 换回**零配置默认实例**，而不是留着上一次烘焙的地址：留着的话，用户在面板上
 * 删掉登记之后请求照样发得出去，只是没人再说得清它发去哪了。换回默认实例后，adapter 自己会以
 * `missing_base_url` 拒绝——那正是撤销登记之后应该发生的事。
 */
export function applyOpenAiCompatEndpoint(baseUrl: string | undefined): void {
  registeredOrigin = baseUrl
  defaultProviderRegistry.register(
    OPENAI_COMPAT_VENDOR_ID,
    createOpenAiCompatAdapter(baseUrl === undefined ? {} : { baseUrl }),
  )
}
