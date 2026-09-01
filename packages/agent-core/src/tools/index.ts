// tools/index.ts —— 工具契约公开面 barrel（issue 卡 S1a，白名单 subpath `@einfach-agent/core/tools`）。
// 只做 re-export，不改任何被引用文件的实现；范围以 docs/core-public-surface-audit.md 的 A/C 类
// 归类 + TOOLS-SPEC.md 为准，经 grep 核对过外部真实消费方后收窄，不做无脑 `export *`：
//
//   · ./types            —— TOOLS-SPEC.md §2 自称的「canonical definitions / Public contract」，
//                            七个工具域 + apps 都在用（`Tool`/`ToolResult`/`ToolContext` 等）。
//                            `ToolContext` 类型本就定义在这里，不在 runtime/toolContext.ts——
//                            后者只导出 `buildToolContext` 工厂（内部装配用，另一会话在改，不碰）。
//   · ./toolRegistry      —— `ToolRegistry` 类型与 `createToolRegistry` 工厂，七个工具域用于
//                            registrar 的入参类型。
//   · ./schemaResult      —— schema 懒加载/未连接 provider 的结果构造入口，`apps/web` 的 MCP
//                            探针在用（C 类）。
//   · ./runtime bridge    —— 工具包唯一可触及宿主能力的契约：workspace 读写/搜索、平台、风险
//                            判级与 ask-user payload。workspace bridge 在调用时才加载，避免普通
//                            工具注册预加载宿主模块。
//
// 不收：
//   · tools/registry.ts 的 `toolRegistry` 单例——A 类，是 `runtime/core/coreInstance` 的重复通路
//     （见盘点 §3.1），白名单只留一条，由根 barrel `.`（S5a）收口。
//   · tools/schemaValidate.ts——盘点 D 类，非测试消费方为零，迁移方向是 S8 改跨包测试深导入，
//     不在这张卡处置。
//   · tools/toolCatalog.ts——当前零外部消费方（值与类型都没有 `@einfach-agent/core/tools/*` 深导入），
//     不在盘点白名单方案（§4 第 4 行）里，需要时按判据另行补卡。

export type {
  LoadedTool,
  RegisteredToolSnapshot,
  ShellCommandInput,
  ShellCommandResult,
  ShellPlatform,
  Tool,
  ToolCallTiming,
  ToolResult,
  ToolRuntime,
  ToolSkill,
  ToolSummary,
  WorkspaceTaskInput,
  WorkspaceTaskKind,
  WorkspaceTaskResult,
} from './types'

export type { SpawnAgentsOptions, ToolContext } from './context'

export type { ToolRegistry } from './toolRegistry'
export { createToolRegistry } from './toolRegistry'

export type { UnconnectedToolProvider, UnconnectedToolProviderProbe } from './schemaResult'
export {
  TOOL_PROVIDER_NOT_CONNECTED_CODE,
  TOOL_SCHEMA_AUTOLOADED_CODE,
  toolProviderNotConnectedResult,
  toolSchemaAutoloadedResult,
  toolSchemaLoadedResult,
} from './schemaResult'

export {
  DANGEROUS_TOOLS,
  MCP_CONNECT_TOOL_NAME,
  classifyToolRisk,
  isDangerousTool,
  isDelegatableDangerousTool,
  isMcpTool,
} from '../runtime/dangerousTools'
export type {
  McpConnectTarget,
  McpConnectTargetProbe,
  McpToolLaunchTargetProbe,
  ToolRisk,
  ToolRiskAssessment,
  ToolRiskContext,
} from '../runtime/dangerousTools'

export {
  applyWorkspacePatch,
  DEFAULT_RG_CONTEXT_LINES,
  DEFAULT_RG_MAX_MATCHES,
  listWorkspaceFiles,
  MAX_RG_CONTEXT_LINES,
  MAX_RG_MATCHES,
  normalizeChangeSummary,
  readWorkspaceFile,
  readWorkspaceRunIndexPage,
  revertWorkspaceChange,
  rgSearchWorkspace,
  searchWorkspaceFiles,
} from './workspaceBridge'
export type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  RgSearchInput,
  RgSearchMatch,
  RgSearchResult,
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceChangeConflict,
  WorkspaceChangeContext,
  WorkspaceChangeSummary,
  WorkspaceFileEntry,
  WorkspaceJsonlLine,
  WorkspacePatchFileChange,
  WorkspacePatchInput,
  WorkspacePatchOperation,
  WorkspacePatchRejected,
  WorkspacePatchResult,
  WorkspaceRevertInput,
  WorkspaceRevertResult,
  WorkspaceRuntimeResult,
  WorkspaceSearchMatch,
} from './workspaceBridge'

// 宿主平台的唯一读出通路（S5）。**不导出 detectLocalPlatform**：本地探测只在「调用方与执行
// 命令的机器同机」时才等于宿主平台，那是宿主装配层的判断，不是工具层的；工具一律读 hostPlatform()。
export { hostPlatform } from '../runtime/hostPlatform'
export type { HostPlatform } from '../runtime/hostPlatform'

export { normalizeAskUserQuestionPayload } from '../runtime/askUserQuestion'
export type {
  AskUserQuestionContext,
  AskUserQuestionItem,
  AskUserQuestionPayload,
  AskUserQuestionType,
} from '../runtime/askUserQuestion'
