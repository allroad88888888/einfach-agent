import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerSqlExecutor, loadServerSqlExecutor } from './serverSqlExecutor'

const invokeServerCommand = vi.hoisted(() => vi.fn())

// 只替换命令客户端：本文件的职责是「两个方法各翻成哪一条命令、参数怎么摆、回执怎么收窄」，
// HTTP 那一层（URL、token、失败信封解析）是 `host/serverInvoke.ts` 自己的用例在管。
vi.mock('../host/serverInvoke', () => ({ invokeServerCommand }))

describe('server 宿主的 SQL 执行面', () => {
  beforeEach(() => {
    invokeServerCommand.mockReset()
  })

  it('execute 打的是 sqlite_execute，并带上连接名与位置参数', async () => {
    invokeServerCommand.mockResolvedValue({ rowsAffected: 3 })
    const executor = createServerSqlExecutor('persistence')

    await expect(executor.execute('DELETE FROM sessions WHERE id = $1', ['s-1']))
      .resolves.toEqual({ rowsAffected: 3 })
    expect(invokeServerCommand).toHaveBeenCalledWith('sqlite_execute', {
      connection: 'persistence',
      sql: 'DELETE FROM sessions WHERE id = $1',
      params: ['s-1'],
    })
  })

  // port 的 `params` 是可选的，而 host-node 那头判「传没传」只看值。这里补成空数组而不是把键
  // 留成 undefined：`JSON.stringify` 会把 undefined 的键整个丢掉，两种传输的键集合于是不同。
  it('不传 params 时补成空数组', async () => {
    invokeServerCommand.mockResolvedValue({ rowsAffected: 0 })
    await createServerSqlExecutor('persistence').execute('CREATE TABLE IF NOT EXISTS t (id TEXT)')
    expect(invokeServerCommand).toHaveBeenCalledWith('sqlite_execute', {
      connection: 'persistence',
      sql: 'CREATE TABLE IF NOT EXISTS t (id TEXT)',
      params: [],
    })
  })

  it('select 打的是 sqlite_select，行数组原样返回', async () => {
    const rows = [{ session_id: 's-1', generation: 7 }]
    invokeServerCommand.mockResolvedValue(rows)

    await expect(createServerSqlExecutor('persistence')
      .select('SELECT * FROM recovery_snapshots WHERE session_id = $1', ['s-1']))
      .resolves.toBe(rows)
    expect(invokeServerCommand).toHaveBeenCalledWith('sqlite_select', {
      connection: 'persistence',
      sql: 'SELECT * FROM recovery_snapshots WHERE session_id = $1',
      params: ['s-1'],
    })
  })

  it('连接名可换，给 P4 的 trace driver 留的槽', async () => {
    invokeServerCommand.mockResolvedValue([])
    await createServerSqlExecutor('observability').select('SELECT 1')
    expect(invokeServerCommand).toHaveBeenCalledWith('sqlite_select', {
      connection: 'observability',
      sql: 'SELECT 1',
      params: [],
    })
  })

  // rowsAffected 是恢复快照那条条件 UPSERT 判 saved / stale / tombstoned 的唯一依据。跨 HTTP
  // 回来的是外部 JSON，形状不对时静默当 0 会表现成「写成功了却被判成 stale」——一次不报错的
  // 快照丢弃。所以这里当场失败。
  it.each([
    ['缺字段', {}],
    ['类型不对', { rowsAffected: '3' }],
    ['非有限数', { rowsAffected: Number.NaN }],
    ['整个是 null', null],
  ])('execute 的回执 %s 时当场失败', async (_label, payload) => {
    invokeServerCommand.mockResolvedValue(payload)
    await expect(createServerSqlExecutor('persistence').execute('SELECT 1'))
      .rejects.toThrow('本地服务的 SQL 回执缺少 rowsAffected')
  })

  // 下游 driver 一律 `catch (error)` 后读 `error.message`，所以失败必须原样上抛、
  // 不能在这里折叠成别的形状（`httpInvoke` 折成裸字符串，正是本文件不用它的理由）。
  it('命令失败原样上抛，不折叠也不吞掉', async () => {
    invokeServerCommand.mockRejectedValue(new Error('SQLite（persistence@/x/web-agent.db）执行失败：database is locked'))
    await expect(createServerSqlExecutor('persistence').execute('SELECT 1'))
      .rejects.toThrow('database is locked')
  })

  it('loadServerSqlExecutor 绑在 persistence 这条连接上', async () => {
    invokeServerCommand.mockResolvedValue([])
    await (await loadServerSqlExecutor()).select('SELECT 1')
    expect(invokeServerCommand).toHaveBeenCalledWith('sqlite_select', expect.objectContaining({
      connection: 'persistence',
    }))
  })
})
