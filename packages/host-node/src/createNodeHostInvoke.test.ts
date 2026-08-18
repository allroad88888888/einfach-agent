import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createNodeHostInvoke, NodeHostCommandError } from './createNodeHostInvoke'
import { NODE_HOST_COMMAND_NAMES } from './commandNames'

describe('createNodeHostInvoke', () => {
  it('把 get_user_home_dir 路由到 os.homedir()', async () => {
    const invoke = createNodeHostInvoke()
    // 调用形态刻意与 core 的 runtime/userSkillsRoot.ts 一致：不传第二个实参。
    await expect(invoke<string>('get_user_home_dir')).resolves.toBe(homedir())
  })

  it('装配槽 homeDir 覆盖 os.homedir()，并去掉结尾斜杠', async () => {
    const invoke = createNodeHostInvoke({ homeDir: '/srv/agent-home/' })
    await expect(invoke<string>('get_user_home_dir')).resolves.toBe('/srv/agent-home')
  })

  it('homeDir 传空白等同于没配置，回落到 os.homedir()', async () => {
    // 空串若被原样当成路径根用，后续所有拼接都会指向文件系统根且不报错，所以必须回落。
    const invoke = createNodeHostInvoke({ homeDir: '   ' })
    await expect(invoke<string>('get_user_home_dir')).resolves.toBe(homedir())
  })

  it('已登记但未实现的命令以 unimplemented 明确失败', async () => {
    const invoke = createNodeHostInvoke()
    const error = await invoke('read_workspace_file', { path: 'a.txt' }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(NodeHostCommandError)
    const commandError = error as NodeHostCommandError
    expect(commandError.reason).toBe('unimplemented')
    expect(commandError.command).toBe('read_workspace_file')
    // 文案要能一眼看出病因是「宿主还没实现」，而不是「参数错了」或「文件不存在」。
    expect(commandError.message).toContain('read_workspace_file')
    expect(commandError.message).toContain('尚未实现')
  })

  it('不在全集里的命令以 unknown-command 失败，与「未实现」分开', async () => {
    const invoke = createNodeHostInvoke()
    const error = await invoke('read_workspace_fil', { path: 'a.txt' }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(NodeHostCommandError)
    expect((error as NodeHostCommandError).reason).toBe('unknown-command')
    expect((error as NodeHostCommandError).message).toContain('未登记')
  })

  it('全集里除 get_user_home_dir 外全部尚未实现（本卡的施工进度）', async () => {
    const invoke = createNodeHostInvoke()
    const implemented: string[] = []
    for (const command of NODE_HOST_COMMAND_NAMES) {
      const reason = await invoke(command, {}).then(
        () => 'ok' as const,
        (error: unknown) =>
          error instanceof NodeHostCommandError ? error.reason : ('threw' as const),
      )
      if (reason !== 'unimplemented') implemented.push(command)
    }
    // 这条会随后续 24 张卡逐步变长——落地一个域就把它的命令名加进来，别把断言改成宽松匹配。
    expect(implemented).toEqual(['get_user_home_dir'])
  })

  it('失败一律是 rejection，不是同步抛出', () => {
    const invoke = createNodeHostInvoke()
    // `void invoke(...).catch(...)` 这种不在 async 函数里的调用点（apps/web 的模型传输层就是）
    // 接不住同步异常。这里直接调、不 await，同步抛出的话本用例会当场失败。
    let settled: unknown
    const pending = invoke('nope').catch((error: unknown) => {
      settled = error
    })
    expect(settled).toBeUndefined()
    return pending.then(() => {
      expect(settled).toBeInstanceOf(NodeHostCommandError)
    })
  })
})
