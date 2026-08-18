// userSkillsRoot 的 colocated 测试：宿主判定、尾斜杠归一、失败降级。
//
// 桩手法：直接用真实的 hostBridge 模块（不 mock），用 configureHostInvoke 登记一个自制的 invoke
// 桩来模拟"有桥"，用 configureHostInvoke(undefined) 模拟"无桥"。不用 hostBridgeMock
// （hostTauri.testHarness.ts）——它把 hasHostBridge() 钉死为 true，而本文件的守卫正是被测对象，
// 钉死了就测不到"无桥 → undefined"那条；也不用 stubHostBridgeFlag（hostBridge.testHarness.ts）
// ——它的桩 invoke 恒 reject，喂不出"返回主目录""尾斜杠"这类需要真实返回值的用例。零 vi.mock，
// 因此也没有对 './hostBridge' 值导入撞 TDZ 的风险（两份 testHarness 文件头记录的那个坑）。
import { afterEach, describe, expect, it } from 'vitest'

import { configureHostInvoke, type HostInvoke } from './hostBridge'
import { resolveUserSkillsRoot } from './userSkillsRoot'

afterEach(() => {
  // hostBridge 的 loader 是模块级单例：不复位会让本文件某条用例登记的桥泄漏进下一条用例。
  configureHostInvoke(undefined)
})

describe('resolveUserSkillsRoot', () => {
  it('未登记桥的宿主返回 undefined', async () => {
    // 故意不调用 configureHostInvoke。
    //
    // 这里刻意**不**断言「invoke 一次都没被调用」：无桥时「守卫生效、直接短路」与「守卫失效、
    // 走到 loadHostInvoke() 拿到 rejection 再被 catch 降级」对外是同一个 undefined，在不 mock
    // hostBridge 的前提下无法区分。本卡交回时曾写成「造一个会计数的 loader、特意不登记它、
    // 断言 calls 为 0」——那是永真断言：loader 压根没登记，计数当然是 0，它连守卫被整个删掉
    // 都发现不了，只会给出虚假的安全感。要真正钉住「不触碰 invoke」得 mock hostBridge 模块，
    // 而那会连 hasHostBridge() 一起钉死，把本用例的被测对象也一并架空。
    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
  })

  it('登记桥的宿主返回主目录', async () => {
    const invoke = (async (cmd: string) => {
      expect(cmd).toBe('get_user_home_dir')
      return '/Users/me'
    }) as HostInvoke
    configureHostInvoke(() => Promise.resolve(invoke))

    await expect(resolveUserSkillsRoot()).resolves.toBe('/Users/me')
  })

  it('去掉尾斜杠：它会变成快照里的展示值与路径拼接的根，带不带斜杠不能随宿主实现漂移', async () => {
    const invoke = (async () => '/Users/me/') as HostInvoke
    configureHostInvoke(() => Promise.resolve(invoke))

    await expect(resolveUserSkillsRoot()).resolves.toBe('/Users/me')
  })

  it('invoke 抛错 → undefined 而不是把整次扫描带崩', async () => {
    const invoke = (async () => {
      throw new Error('no home')
    }) as HostInvoke
    configureHostInvoke(() => Promise.resolve(invoke))

    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
  })

  it('invoke 返回空白串 → undefined（空根会让 `.claude/skills` 变成相对进程 cwd）', async () => {
    const invoke = (async () => '   ') as HostInvoke
    configureHostInvoke(() => Promise.resolve(invoke))

    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
  })
})
