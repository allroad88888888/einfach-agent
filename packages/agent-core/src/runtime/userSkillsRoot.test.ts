// userSkillsRoot 的 colocated 测试：宿主判定、尾斜杠归一、失败降级。
// mock 手法同 hostTauri.test.ts —— 工厂惰性执行，本身就是「该模块有没有被加载」的探针。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pathModule = vi.hoisted(() => ({ loads: 0, homeDir: vi.fn(async () => '/Users/me') }))

vi.mock('@tauri-apps/api/path', () => {
  pathModule.loads += 1
  return { homeDir: pathModule.homeDir }
})

import { resolveUserSkillsRoot } from './userSkillsRoot'

type GlobalWithIsTauri = typeof globalThis & { isTauri?: boolean }
const globalWithIsTauri = globalThis as GlobalWithIsTauri
const hadIsTauriProperty = Object.prototype.hasOwnProperty.call(globalThis, 'isTauri')
const originalIsTauriValue = globalWithIsTauri.isTauri

describe('resolveUserSkillsRoot', () => {
  beforeEach(() => {
    pathModule.homeDir.mockReset()
    pathModule.homeDir.mockResolvedValue('/Users/me')
  })

  afterEach(() => {
    if (hadIsTauriProperty) globalWithIsTauri.isTauri = originalIsTauriValue
    else delete globalWithIsTauri.isTauri
  })

  it('非 Tauri 宿主返回 undefined，且不触碰 path 模块', async () => {
    delete globalWithIsTauri.isTauri
    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
    expect(pathModule.loads).toBe(0)
  })

  it('Tauri 宿主返回主目录', async () => {
    globalWithIsTauri.isTauri = true
    await expect(resolveUserSkillsRoot()).resolves.toBe('/Users/me')
  })

  it('去掉尾斜杠：它会变成快照里的展示值与路径拼接的根，带不带斜杠不能随宿主版本漂移', async () => {
    globalWithIsTauri.isTauri = true
    pathModule.homeDir.mockResolvedValue('/Users/me/')
    await expect(resolveUserSkillsRoot()).resolves.toBe('/Users/me')
  })

  it('homeDir 抛错 → undefined 而不是把整次扫描带崩', async () => {
    globalWithIsTauri.isTauri = true
    pathModule.homeDir.mockRejectedValue(new Error('no home'))
    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
  })

  it('homeDir 返回空串 → undefined（空根会让 `.claude/skills` 变成相对进程 cwd）', async () => {
    globalWithIsTauri.isTauri = true
    pathModule.homeDir.mockResolvedValue('   ')
    await expect(resolveUserSkillsRoot()).resolves.toBeUndefined()
  })
})
