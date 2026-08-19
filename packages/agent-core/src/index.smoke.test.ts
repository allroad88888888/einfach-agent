// 根 barrel 的模块图冒烟（卡 S5a，探针于 D3 升级）。守两件事：
//   1. `@tauri-apps/plugin-dialog` 不进静态模块图——这是 S2c（3911c9d）那次回归的同款风险：
//      静态导链会在各测试文件的 vi.mock 生效前灌满 worker 模块图。探测手法照抄 workspaceRead 系
//      测试的 mock 姿势：`vi.mock` 的工厂是惰性的，只在该模块**真的**被 import 时才跑，于是工厂
//      本身就是一个"是否被加载"的探针。D3 把 workspaceDialog 的 `open` 改成惰性 import 后，
//      这条从「barrel 不含它」加强成「连深路径 import workspaceDialog 都不含它」，反证也随之
//      从「import 深路径」下移到「真的调用 pickWorkspaceDirectory()」。
//   2. 公开面的红线：writer / 重复通路 / 仅测试导出没混进 barrel。
import { afterEach, describe, expect, it, vi } from 'vitest'

const loads = vi.hoisted(() => ({ dialog: 0 }))

vi.mock('@tauri-apps/plugin-dialog', () => {
  loads.dialog += 1
  return { open: vi.fn(async () => '/mock/workspace') }
})

import * as rootBarrel from './index'

type GlobalWithIsTauri = typeof globalThis & { isTauri?: boolean }
const globalWithIsTauri = globalThis as GlobalWithIsTauri
const hadIsTauriProperty = Object.prototype.hasOwnProperty.call(globalThis, 'isTauri')
const originalIsTauriValue = globalWithIsTauri.isTauri

describe('@einfach-agent/core 根 barrel', () => {
  // 三条探针用例依赖 vitest 默认的声明顺序串行执行：前两条必须跑在本文件第一次调用
  // pickWorkspaceDirectory() 之前，否则 load-count 已被推到 1，断言失去意义。
  afterEach(() => {
    // 恢复现场：还原到本文件加载时的原始 globalThis.isTauri 状态（手法同 hostTauri.test.ts）。
    if (hadIsTauriProperty) globalWithIsTauri.isTauri = originalIsTauriValue
    else delete globalWithIsTauri.isTauri
  })

  it('静态导链不把 @tauri-apps/plugin-dialog 拉进模块图', () => {
    // 此刻 ./index 已完成求值（顶层 import），探针仍为 0 即证明 barrel 不静态连 plugin-dialog。
    expect(loads.dialog).toBe(0)
  })

  it('根 barrel 的 workspaceDialog 导出同样不加载 @tauri-apps/plugin-dialog', async () => {
    // D3 交付的新性质：连模块本体求值都不碰 plugin-dialog，且非 Tauri 宿主下调用也走守卫早返回，
    // 加载点在守卫之后——这两步过后探针必须还是 0。
    const { canPickWorkspaceDirectory, pickWorkspaceDirectory } = rootBarrel
    expect(loads.dialog).toBe(0)

    expect(canPickWorkspaceDirectory()).toBe(false)
    await expect(pickWorkspaceDirectory()).resolves.toEqual({
      ok: false,
      error: '选择 workspace 目录：当前宿主未提供命令桥',
    })
    expect(loads.dialog).toBe(0)
  })

  it('探针有效：Tauri 宿主下真的调用 pickWorkspaceDirectory() 才触发加载', async () => {
    // 反证上两条不是恒 0 的空断言——同一个探针在真的走到 open() 那步时必须跳到 1。
    const { pickWorkspaceDirectory } = rootBarrel
    globalWithIsTauri.isTauri = true

    await expect(pickWorkspaceDirectory()).resolves.toEqual({ ok: true, path: '/mock/workspace' })
    expect(loads.dialog).toBe(1)
  })

  it('导出宿主装配 API 的值面', () => {
    for (const name of [
      'defaultCore',
      'configureDefaultProjectSkillsProvider',
      'configureHostInvoke',
      'configureCommands',
      'sendMessage',
      'sessionAtomScope',
      'subscribeAgentEvents',
      'configurePersistence',
      'hydratePersistence',
      'scanPlugins',
      'loadScannedPlugins',
      'buildProjectSkillsWorkspaceBridge',
      'resolveUserSkillsRoot',
      'canPickWorkspaceDirectory',
      'pickWorkspaceDirectory',
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
