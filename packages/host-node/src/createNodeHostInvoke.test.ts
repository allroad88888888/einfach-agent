import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHistoryCapabilityProvider, AgentRolloutDriver } from '@einfach-agent/core/history'
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

  // 这条用例的样本命令一直要挑「当前还没实现」的那一条，每接线一个域就得换一次
  // （read_workspace_file → mcp_list_tools → …）。**M1/C1 落地后 28 条全部实现，
  // 于是经公开工厂已经构造不出 `unimplemented`**——这正是本线做完的标志。
  // 所以改成直接构造错误对象验失败形态：`unimplemented` 这条分支仍要留着，因为
  // 路由表是 `Partial`，将来 commandNames.ts 新增一条命令而域没跟上时它就是唯一的报信人。
  it('unimplemented 与 unknown-command 是两种失败，文案各自指向病因', () => {
    const unimplemented = new NodeHostCommandError('some_future_command', 'unimplemented')
    expect(unimplemented.reason).toBe('unimplemented')
    expect(unimplemented.command).toBe('some_future_command')
    // 文案要能一眼看出病因是「宿主还没实现」，而不是「参数错了」或「文件不存在」。
    expect(unimplemented.message).toContain('some_future_command')
    expect(unimplemented.message).toContain('尚未实现')

    const unknown = new NodeHostCommandError('read_workspace_fil', 'unknown-command')
    expect(unknown.reason).toBe('unknown-command')
    expect(unknown.message).toContain('未登记')
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

  it('当前已实现的命令集合（本线的施工进度）', async () => {
    // 隔离到临时主目录 + 临时配置目录：这条用例会真的调用 `mcp_config_read`，不隔离的话它会去
    // 读、并可能迁移运行测试那个人的 `~/.webAgent/config.json`。
    const home = await mkdtemp(join(tmpdir(), 'web-agent-host-invoke-'))
    const savedOverride = process.env.WEB_AGENT_CONFIG_DIR
    process.env.WEB_AGENT_CONFIG_DIR = join(home, 'config')
    try {
      const invoke = createNodeHostInvoke({ homeDir: home, openWorkspaceDirectory: async () => undefined })
      const implemented: string[] = []
      for (const command of NODE_HOST_COMMAND_NAMES) {
        const reason = await invoke(command, {}).then(
          () => 'ok' as const,
          (error: unknown) =>
            error instanceof NodeHostCommandError ? error.reason : ('threw' as const),
        )
        if (reason !== 'unimplemented') implemented.push(command)
      }
      // 这条会随后续卡逐步变长——落地一个域就把它的命令名加进来，别把断言改成宽松匹配。
      // 顺序跟随 NODE_HOST_COMMAND_NAMES 的遍历序（即 commandNames.ts 的域顺序），不是登记顺序。
      expect(implemented).toEqual([
        'read_workspace_file',
        'read_workspace_image',
        'read_workspace_run_index_page',
        'list_workspace_files',
        'search_workspace_files',
        'write_workspace_file',
        'apply_workspace_patch',
        'revert_workspace_change',
        'delete_workspace_path',
        'copy_workspace_path',
        'move_workspace_path',
        'get_workspace_diff',
        'rg_search_workspace',
        'run_workspace_task',
        'pick_workspace_directory',
        'run_shell_command',
        'mcp_connect',
        'mcp_list_tools',
        'mcp_call_tool',
        'mcp_disconnect',
        'cancel_model_provider_request',
        'cancel_model_chat_completions',
        'model_credential_status',
        'model_credential_set',
        'model_credential_delete',
        'model_endpoint_status',
        'model_endpoint_set',
        'model_endpoint_delete',
        'model_connection_profile_list',
        'model_connection_profile_read',
        'model_connection_profile_save',
        'model_connection_profile_delete',
        'model_connection_profile_probe',
        'mcp_config_read',
        'mcp_config_write',
        'get_user_home_dir',
        'sqlite_execute',
        'sqlite_select',
        'agent_rollout_append',
        'agent_rollout_reconcile',
        'agent_history_list',
        'agent_history_list_items',
        'agent_history_read_item',
        'agent_history_search',
      ])
    } finally {
      if (savedOverride === undefined) delete process.env.WEB_AGENT_CONFIG_DIR
      else process.env.WEB_AGENT_CONFIG_DIR = savedOverride
      await rm(home, { recursive: true, force: true })
    }
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

  it('registers one rollout flush disposer alongside the MCP disposer', async () => {
    const disposers: Array<() => Promise<void>> = []
    createNodeHostInvoke({ registerHostDisposer(dispose) { disposers.push(dispose) } })
    expect(disposers).toHaveLength(2)
    await expect(Promise.all(disposers.map((dispose) => dispose()))).resolves.toHaveLength(2)
  })

  it('uses one injected rollout driver for routes and its single flush disposer', async () => {
    const driver: AgentRolloutDriver = {
      append: vi.fn(async () => ({ records: [] })),
      reconcile: vi.fn(async () => ({ histories: [] })),
      flush: vi.fn(async () => undefined),
    }
    const disposers: Array<() => Promise<void>> = []
    const invoke = createNodeHostInvoke({ agentRolloutDriver: driver,
      registerHostDisposer(dispose) { disposers.push(dispose) } })
    await expect(invoke('agent_rollout_reconcile', {})).resolves.toEqual({ histories: [] })
    expect(driver.reconcile).toHaveBeenCalledOnce()
    expect(disposers).toHaveLength(2)
    await Promise.all(disposers.map((dispose) => dispose()))
    expect(driver.flush).toHaveBeenCalledOnce()
  })

  it('rejects a borrowed rollout lifecycle without an injected driver', () => {
    expect(() => createNodeHostInvoke({ agentRolloutDriverLifecycle: 'borrowed' }))
      .toThrow('requires an injected')
  })

  it('uses a borrowed history provider identity for host routes', async () => {
    const listHistories = vi.fn(async () => ({ histories: [], warnings: [] }))
    const provider = { forContext: vi.fn(() => ({ listHistories, listItems: vi.fn(),
      readItem: vi.fn(), search: vi.fn() })) } as unknown as AgentHistoryCapabilityProvider
    const driver: AgentRolloutDriver = { append: vi.fn(), reconcile: vi.fn(), flush: vi.fn() }
    const invoke = createNodeHostInvoke({ agentHistoryProvider: provider,
      agentRolloutDriver: driver, agentRolloutDriverLifecycle: 'borrowed' })
    await expect(invoke('agent_history_list', { input: {} })).resolves.toEqual({ histories: [], warnings: [] })
    expect(provider.forContext).toHaveBeenCalledOnce()
    expect(driver.reconcile).not.toHaveBeenCalled()
  })
})
