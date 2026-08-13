// 根 barrel 的模块图冒烟（卡 S5a）。守两件事：
//   1. `import '@web-agent/core'` 不把 `@tauri-apps/plugin-dialog` 拉进模块图——这是 S2c（3911c9d）
//      那次回归的同款风险：barrel 的静态导链会在各测试文件的 vi.mock 生效前灌满 worker 模块图。
//      探测手法照抄 workspaceRead 系测试的 mock 姿势：`vi.mock` 的工厂是惰性的，只在该模块**真的**
//      被 import 时才跑，于是工厂本身就是一个"是否被加载"的探针。
//   2. 公开面的红线：writer / 重复通路 / 仅测试导出没混进 barrel。
import { describe, expect, it, vi } from 'vitest'

const loads = vi.hoisted(() => ({ dialog: 0 }))

vi.mock('@tauri-apps/plugin-dialog', () => {
  loads.dialog += 1
  return { open: vi.fn() }
})

import * as rootBarrel from './index'

describe('@web-agent/core 根 barrel', () => {
  it('静态导链不把 @tauri-apps/plugin-dialog 拉进模块图', () => {
    // 此刻 ./index 已完成求值（顶层 import），探针仍为 0 即证明 workspaceDialog 不在静态图里。
    expect(loads.dialog).toBe(0)
  })

  it('探针有效：直接 import runtime/workspaceDialog 会触发加载', async () => {
    // 反证上一条不是空断言——同一个探针在真的引用那条深路径时必须跳到 1。
    await import('./runtime/workspaceDialog')
    expect(loads.dialog).toBe(1)
  })

  it('导出宿主装配 API 的值面', () => {
    for (const name of [
      'defaultCore',
      'configureDefaultProjectSkillsProvider',
      'configureCommands',
      'sendMessage',
      'sessionAtomScope',
      'subscribeAgentEvents',
      'configurePersistence',
      'hydratePersistence',
      'scanPlugins',
      'loadScannedPlugins',
      'normalizeAskUserQuestionPayload',
      'contextInputBudgetTokens',
      'rootStore',
      'itemsAtom',
      'contextStatsAtom',
      'resolveSessionWorkspaceRoot',
      'executionGraphAtom',
    ]) {
      expect(rootBarrel, name).toHaveProperty(name)
    }
  })

  it('不导出 writer、重复通路与仅测试导出', () => {
    for (const name of [
      'toolRegistry', // 重复通路：等于 defaultCore.tools（盘点 §3.1）
      'pickWorkspaceDirectory', // 连 @tauri-apps/plugin-dialog，留在深路径
      'canPickWorkspaceDirectory',
      'setAssistantStream', // transientAtoms 的 mutation —— UI 只读 atom 红线
      'setContextStats',
      'upsertToolActivity',
      'getPendingQuestionAnswers', // transientAtoms 的 reader，同上
      'resetRootStore', // 仅测试
      'createCoreInstance', // 建隔离实例走 ./plugin 的 createCore()
    ]) {
      expect(rootBarrel, name).not.toHaveProperty(name)
    }
  })
})
