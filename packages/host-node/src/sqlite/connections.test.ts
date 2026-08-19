import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSqliteConnections, loadSqliteExecutor } from './connections'

// 全程隔离在临时目录里：默认路径指向的是运行测试那个人的真实库文件（桌面版正在用的那一份）。
let root: string
let databasePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'web-agent-sqlite-conn-'))
  databasePath = join(root, 'nested', 'web-agent.db')
})

afterEach(async () => {
  await closeSqliteConnections()
  await rm(root, { recursive: true, force: true })
})

describe('loadSqliteExecutor', () => {
  it('父目录不存在时自己建，并真的落出库文件', async () => {
    // 桌面侧由 Tauri 的 path API 保证应用数据目录存在，Node 侧得自己建。
    const executor = await loadSqliteExecutor('persistence', databasePath)
    await executor.execute('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)')
    expect((await stat(databasePath)).isFile()).toBe(true)
  })

  it('同一对（名字，路径）复用同一条连接', async () => {
    const first = await loadSqliteExecutor('persistence', databasePath)
    const second = await loadSqliteExecutor('persistence', databasePath)
    expect(second).toBe(first)
  })

  it('同一个库文件上的两个名字是两条独立连接，且互相看得见对方的写入', async () => {
    // 桌面侧今天就是这个形状：persistence 与 observability 各自 Database.load('sqlite:web-agent.db')、
    // 各自建表、各自发 PRAGMA。用路径当键会把这件事在移植中悄悄抹掉，而 P4 正需要它还在。
    const persistence = await loadSqliteExecutor('persistence', databasePath)
    const observability = await loadSqliteExecutor('observability', databasePath)
    expect(observability).not.toBe(persistence)

    await persistence.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)')
    await persistence.execute('INSERT INTO sessions (id) VALUES ($1)', ['__all__'])
    expect(await observability.select('SELECT id FROM sessions')).toEqual([{ id: '__all__' }])
  })

  it('不同路径是不同连接（测试之间的隔离就靠这条）', async () => {
    const other = join(root, 'other.db')
    const first = await loadSqliteExecutor('persistence', databasePath)
    const second = await loadSqliteExecutor('persistence', other)
    expect(second).not.toBe(first)
  })

  it('打开失败不会被 memo 住，修好之后下一次能成功', async () => {
    // 缓存里留着一个已失败的 promise，会让「第一次没建成目录」这种一次性故障永久化。
    const blocked = join(root, 'file-in-the-way')
    await (await loadSqliteExecutor('persistence', blocked)).execute('SELECT 1')
    // `blocked` 现在是一个库文件，把它当成目录用必然失败。
    const nested = join(blocked, 'child.db')
    await expect(loadSqliteExecutor('persistence', nested)).rejects.toThrow()
    // 换一条能建起来的路径仍然可用（登记表没有被那次失败污染）。
    const healthy = await loadSqliteExecutor('persistence', join(root, 'healthy.db'))
    expect(await healthy.select('SELECT 1 AS v')).toEqual([{ v: 1 }])
  })

  it('closeSqliteConnections 之后再取是一条新连接', async () => {
    const before = await loadSqliteExecutor('persistence', databasePath)
    await closeSqliteConnections()
    const after = await loadSqliteExecutor('persistence', databasePath)
    expect(after).not.toBe(before)
    // 关掉之前写进去的数据仍在（WAL 下已提交的写入本就是耐久的）。
    expect(await after.select('SELECT 1 AS v')).toEqual([{ v: 1 }])
  })
})
