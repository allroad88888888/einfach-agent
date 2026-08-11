// tools/toolCatalog.ts —— 工具注册表的【只读投影】抽象。
//
// 为什么单独一层：ToolRegistry 是进程级可变单例——MCP 的 tools/list_changed 与断线会随时
// register / unregister。但「已经组装给模型看的那份清单」必须能被某个消费者钉住，否则模型
// 在 T0 依据清单做的决策，到 T1 调用时清单已经变形。ToolCatalog 把 registry 的【读面】
// （list / loadSchema / registrationVersion / has / replayUnsafeToolNames）抽成独立接口，
// 于是 registry 本身、以及任何一份不可变快照，都能填进同一个洞。
//
// 边界：本文件零副作用、零依赖（只 ./types）。它不知道 run、不知道 core，也不注册任何东西；
// run 级别的固定语义住在 runtime/toolEpoch.ts。

import type { RegisteredToolSnapshot, Tool, ToolSummary } from './types'

/** 工具目录的只读读面。ToolRegistry 与它的不可变快照都实现本接口。 */
export interface ToolCatalog {
  /** manifest-only 摘要（不含 inputSchema/guide）。每次调用返回新数组与新摘要对象。 */
  list(): ToolSummary[]
  /** 懒加载完整快照（含 registrationVersion + inputSchema + guide）；未知名 → undefined。 */
  loadSchema(name: string): RegisteredToolSnapshot | undefined
  /** 当前可见注册实例的版本；不可见时 undefined。 */
  registrationVersion(name: string): number | undefined
  has(name: string): boolean
  /** 压缩后不可重放的工具名集合。 */
  replayUnsafeToolNames(): ReadonlySet<string>
}

/** 一次注册：工具实例 + 该次注册签发的单调版本。 */
export interface ToolRegistrationEntry {
  readonly tool: Tool
  readonly registrationVersion: number
}

/** manifest-only 摘要的唯一构造点：registry 与快照必须逐字一致，否则发现面会出现两套事实。 */
export function toolSummaryOf(tool: Tool): ToolSummary {
  return {
    name: tool.name,
    description: tool.skill.description,
    ...(tool.skill.triggers?.length ? { triggers: [...tool.skill.triggers] } : {}),
    runtime: tool.runtime,
  }
}

/** 在摘要之上补 registrationVersion + inputSchema + guide(=skill.content)。 */
export function toolSnapshotOf(entry: ToolRegistrationEntry): RegisteredToolSnapshot {
  return {
    ...toolSummaryOf(entry.tool),
    registrationVersion: entry.registrationVersion,
    inputSchema: entry.tool.inputSchema,
    guide: entry.tool.skill.content,
  }
}

/**
 * 把若干注册冻结成一份不可变目录。
 *
 * 「不可变」指的是【成员与版本】：之后 registry 再怎么 register / unregister，本快照的
 * list / loadSchema / registrationVersion 都不变。快照持有 Tool 实例的引用（不深拷贝
 * inputSchema），因为 Tool 本身按约定是只读的。
 */
export function createToolCatalogSnapshot(
  entries: Iterable<ToolRegistrationEntry>,
): ToolCatalog {
  const frozen = new Map<string, ToolRegistrationEntry>()
  for (const entry of entries) {
    frozen.set(entry.tool.name, { tool: entry.tool, registrationVersion: entry.registrationVersion })
  }
  const replayUnsafe = new Set<string>()
  for (const { tool } of frozen.values()) if (tool.replayUnsafe) replayUnsafe.add(tool.name)

  return {
    list() {
      return Array.from(frozen.values(), (entry) => toolSummaryOf(entry.tool))
    },
    loadSchema(name) {
      const entry = frozen.get(name)
      return entry ? toolSnapshotOf(entry) : undefined
    },
    registrationVersion(name) {
      return frozen.get(name)?.registrationVersion
    },
    has(name) {
      return frozen.has(name)
    },
    replayUnsafeToolNames() {
      return replayUnsafe
    },
  }
}
