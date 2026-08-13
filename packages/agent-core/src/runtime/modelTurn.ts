// 多轮 tool 循环的纯函数 helper（组 system / 组 tools / 解析响应）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
// 本文件是这组 helper 的【稳定出口】：实现按职责分居下列模块，消费方仍从 './modelTurn' 取。
//   · modelTurnSystemItems —— buildSystemItem / buildEnvironmentItem / buildCustomInstructionsItem，
//     请求稳定前缀里的各条 system 消息。
//   · toolManifest —— buildToolManifestText（进稳定前缀的全量工具摘要，仅 name/description/runtime）
//     与 searchToolManifestPage（request_tool_schema 用的有界分页发现）。
//   · turnToolVisibility —— BuildTurnToolsOptions 与「当前环境/权限下可发现」的共用判据。
//   · turnToolSet —— buildTurnTools（TK3：request_tool_schema 恒在场 + 已懒加载的 visible tools；
//     未加载的工具永不进 tools）、selectTurnLoadedTools 与 touchRecentToolName。
//   · toolSchemaCanonical —— canonicalizeJsonSchema 与 toolSetSchemaFingerprint。
//   · loadedToolHistory —— loadedToolNamesFromHistory，从历史恢复已加载的工具名。
//   · narrowToolCalls —— 把宽松响应收窄成请求侧必填形状。
//   · toolCallArgs —— parseToolCallArgs：判别联合版的参数解析（区分「没传参」与「传了坏 JSON」），
//     主循环（modelRun）与子 agent 循环（subagents/runtime）共用同一份判据。

export {
  buildCustomInstructionsItem,
  buildEnvironmentItem,
  buildSystemItem,
} from './modelTurnSystemItems'
export type { EnvironmentItemInput } from './modelTurnSystemItems'

export {
  buildToolManifestText,
  DEFAULT_TOOL_MANIFEST_PAGE_SIZE,
  MAX_TOOL_MANIFEST_PAGE_SIZE,
  MAX_TOOL_MANIFEST_QUERY_LENGTH,
  searchToolManifestPage,
} from './toolManifest'
export type {
  ToolManifestError,
  ToolManifestPage,
  ToolManifestResult,
  ToolManifestSearchInput,
} from './toolManifest'

export type { BuildTurnToolsOptions } from './turnToolVisibility'

export { buildTurnTools, selectTurnLoadedTools, touchRecentToolName } from './turnToolSet'

export { canonicalizeJsonSchema, toolSetSchemaFingerprint } from './toolSchemaCanonical'

export { loadedToolNamesFromHistory } from './loadedToolHistory'

export { narrowToolCalls } from './narrowToolCalls'

export { parseToolCallArgs } from './toolCallArgs'
export type { ToolArgsParse } from './toolCallArgs'
