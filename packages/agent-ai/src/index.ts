// @einfach-agent/ai —— provider 抽象层（pi-ai 对应物）。
// ---------------------------------------------------------------------------
// 这是「实例化 + 拆包」里最自包含的一层：只依赖 fetch 与自身线协议类型，零依赖 state/runtime/tools。
// 对外只暴露这一个 barrel；消费方一律 `import { ... } from '@einfach-agent/ai'`，不深链子模块。
//   · modelApi —— 共享线协议类型 + 底层 postChatCompletion(/Stream) + 指数退避重试。
//   · deepseek / glm —— 各 provider 的请求特化与调用入口。
export * from './modelApi'
export * from './builtinModelDescriptors'
export * from './builtinProviders'
export * from './deepseek'
export * from './deepseekFileDisposal'
export * from './deepseekFiles'
export * from './deepseekMessages'
export * from './finishReasonExtensions'
export * from './glm'
export * from './historyImageCompatibility'
export * from './imageCapability'
export * from './kimi'
export * from './kimiFileDisposal'
export * from './kimiFiles'
export * from './kimiMessages'
export * from './kimiRegion'
export * from './modelAdapter'
export * from './modelCapacityEscalation'
export * from './modelContent'
export * from './modelThinkingCapability'
export * from './providerRegistry'
export {
  createProviderTransportFetch,
  type ProviderLocalRequestIdentity,
} from './providerLocalTransport'
export * from './providerTransport'
export * from './vendorDescriptor'
