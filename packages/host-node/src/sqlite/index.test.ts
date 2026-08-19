import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSqliteConnections, createNodeSqlExecutorLoader, createSqliteRoutes } from './index'
import { NODE_HOST_COMMANDS_BY_DOMAIN } from '../commandNames'

let root: string
let options: { homeDir: string; databasePath: string }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-agent-sqlite-domain-'))
  options = { homeDir: root, databasePath: join(root, 'web-agent.db') }
})

afterEach(async () => {
  await closeSqliteConnections()
  await rm(root, { recursive: true, force: true })
})

describe('sqlite 域 registrar', () => {
  it('交出的键与 commandNames.ts 里本域登记的命令逐字一致', () => {
    // 路由表的键被约束在 NodeHostCommandName 上，所以写错名字是编译错误；这条钉的是另一头：
    // 表里登记了、registrar 却没实现（缺席在类型上是合法的 `Partial`，只会在运行时报「未实现」）。
    expect(Object.keys(createSqliteRoutes(options)).sort()).toEqual(
      [...NODE_HOST_COMMANDS_BY_DOMAIN.sqlite].sort(),
    )
  })

  it('不传 options 也能构造（全取默认，不在构造时打开库文件）', () => {
    // 打开必须是惰性的：装配期就去建目录 / 开文件，会让一次装配在「本机根本不打算用 SQLite」
    // 的场景下也产生副作用。
    expect(Object.keys(createSqliteRoutes())).toHaveLength(2)
  })
})

describe('createNodeSqlExecutorLoader', () => {
  it('是 loader 而不是已就绪的执行面，且解析出来的执行面真的能跑', async () => {
    const loader = createNodeSqlExecutorLoader(options, 'persistence')
    expect(typeof loader).toBe('function')
    const executor = await loader()
    await executor.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)')
    await executor.execute('INSERT INTO sessions (id) VALUES ($1)', ['__all__'])
    expect(await executor.select('SELECT id FROM sessions')).toEqual([{ id: '__all__' }])
  })

  it('进程内 loader 与路由表落在同一条连接上', async () => {
    // 同一个宿主里两种用法（CLI 进程内注入 + HTTP 路由表）不该在同一个库文件上开出两倍句柄。
    const routes = createSqliteRoutes(options)
    await routes.sqlite_execute?.({ connection: 'persistence', sql: 'CREATE TABLE t (v INTEGER)' })
    const executor = await createNodeSqlExecutorLoader(options, 'persistence')()
    await executor.execute('INSERT INTO t (v) VALUES ($1)', [42])
    expect(await routes.sqlite_select?.({ connection: 'persistence', sql: 'SELECT v FROM t' })).toEqual(
      [{ v: 42 }],
    )
  })
})
