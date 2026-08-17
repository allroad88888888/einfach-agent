// 定时工具的注册簿：按 callTiming 分桶并保持注册顺序，不暴露给模型。
// ---------------------------------------------------------------------------
// 【为什么独立成文件】coreInstance 组装实例时需要这个工厂，而 timedDispatch 这个派发模块
// 静态依赖 state/*（runAtom / patchRun / 执行围栏）。若 coreInstance 为拿工厂而静态 import
// 派发模块，就会闭合 coreInstance → timedDispatch → state/sessionWriters → state/rootStore
// → coreInstance 这条环：rootStore 在模块顶层读 `defaultCore.rootStore`，环里它会读到
// undefined 并直接抛。本文件只依赖 tools/* 的类型，是这条链上的叶子，coreInstance 引它安全。

import type { ToolCallTiming } from '../tools/toolCallTiming'
import type { Tool } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'

export interface TimedToolRegistration {
  name: string
  registrationVersion: number
  runtime: Tool['runtime']
}

/** Keeps each callTiming bucket in the registry's insertion order without exposing timed tools to models. */
export function createTimedToolRegistry(registry: ToolRegistry): {
  tools: ToolRegistry
  registrations(timing: ToolCallTiming): readonly TimedToolRegistration[]
} {
  const timedNames = new Map<ToolCallTiming, string[]>()
  const timingByName = new Map<string, ToolCallTiming>()
  const runtimeByName = new Map<string, Tool['runtime']>()
  const registrationOrder = new Map<string, number>()
  let nextRegistrationOrder = 0

  function removeTimedName(name: string, timing: ToolCallTiming | undefined): void {
    if (!timing) return
    const names = timedNames.get(timing)
    if (!names) return
    const index = names.indexOf(name)
    if (index >= 0) names.splice(index, 1)
    if (names.length === 0) timedNames.delete(timing)
  }

  function addTimedName(name: string, timing: ToolCallTiming | undefined): void {
    if (!timing) return
    const names = timedNames.get(timing) ?? []
    const order = registrationOrder.get(name)!
    const index = names.findIndex((candidate) => registrationOrder.get(candidate)! > order)
    if (index < 0) names.push(name)
    else names.splice(index, 0, name)
    timedNames.set(timing, names)
  }

  const tools: ToolRegistry = {
    ...registry,
    register(tool: Tool) {
      const existed = registry.has(tool.name)
      const previousTiming = registry.callTiming(tool.name)
      registry.register(tool)
      const timing = registry.callTiming(tool.name)
      if (!existed) registrationOrder.set(tool.name, nextRegistrationOrder++)
      if (timing) runtimeByName.set(tool.name, tool.runtime)
      else runtimeByName.delete(tool.name)
      if (previousTiming === timing) return
      removeTimedName(tool.name, previousTiming)
      if (timing) timingByName.set(tool.name, timing)
      else timingByName.delete(tool.name)
      addTimedName(tool.name, timing)
    },
    unregister(name, expected) {
      const timing = timingByName.get(name)
      const removed = registry.unregister(name, expected)
      if (!removed) return false
      removeTimedName(name, timing)
      timingByName.delete(name)
      runtimeByName.delete(name)
      registrationOrder.delete(name)
      return true
    },
  }

  return {
    tools,
    registrations(timing) {
      const names = timedNames.get(timing)
      if (!names) return []
      return names.flatMap((name) => {
        const registrationVersion = tools.registrationVersion(name)
        const runtime = runtimeByName.get(name)
        return registrationVersion === undefined || !runtime || tools.callTiming(name) !== timing
          ? []
          : [{ name, registrationVersion, runtime }]
      })
    },
  }
}
