// 根 barrel 的公开面红线冒烟（卡 S5a）：writer / 重复通路 / 仅测试导出没混进 barrel。
//
// 【T1 删掉了什么】本文件此前还守着「桌面 dialog 插件不进静态模块图」那三条探针
// 用例（S2c 3911c9d 的回归：静态导链会在各测试文件的 vi.mock 生效前灌满 worker 模块图）。
// 桌面端整条退出后 `runtime/workspaceDialog` 连同它唯一的上游包一起消失，那三条探针再无
// 被测对象。**「barrel 不新增静态上游边」这条纪律本身仍在**——今天 core 一个宿主上游包都不
// 认识（`runtime/hostBridge.ts` 只收注入的 loader），将来真要再引一个才需要把探针立回来。
import { describe, expect, it } from 'vitest'

import * as rootBarrel from './index'

describe('@einfach-agent/core 根 barrel', () => {
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
