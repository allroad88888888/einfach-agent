// SQLite history checkpoint 的序列化与 best-effort 降级测试。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Checkpoint, CheckpointFinishReason, CheckpointKind } from '../checkpoint.type'

interface CheckpointRow {
  session_id: string
  turn_index: number
  label: string
  kind: CheckpointKind | null
  finish_reason: CheckpointFinishReason | null
  created_at: number
  items: string
  plan: string | null
  recovery: string | null
  plan_stage_checkpoints: string | null
}

function createFakeDatabase() {
  const checkpoints: CheckpointRow[] = []
  return {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE')) return { rowsAffected: 0 }
      if (sql.includes('INSERT OR REPLACE INTO checkpoints')) {
        const [
          session_id,
          turn_index,
          label,
          kind,
          finish_reason,
          created_at,
          items,
          plan,
          recovery,
          plan_stage_checkpoints,
        ] = params as [
          string,
          number,
          string,
          CheckpointKind | null,
          CheckpointFinishReason | null,
          number,
          string,
          string | null,
          string | null,
          string | null,
        ]
        const row = {
          session_id,
          turn_index,
          label,
          kind,
          finish_reason,
          created_at,
          items,
          plan,
          recovery,
          plan_stage_checkpoints,
        }
        const index = checkpoints.findIndex(
          (checkpoint) => checkpoint.session_id === session_id && checkpoint.turn_index === turn_index,
        )
        if (index >= 0) checkpoints[index] = row
        else checkpoints.push(row)
        return { rowsAffected: 1 }
      }
      if (sql.includes('DELETE FROM checkpoints') && sql.includes('turn_index >')) {
        const [sessionId, turnIndex] = params as [string, number]
        for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
          if (
            checkpoints[index].session_id === sessionId
            && checkpoints[index].turn_index > turnIndex
          ) checkpoints.splice(index, 1)
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('DELETE FROM checkpoints')) {
        const [sessionId] = params as [string]
        for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
          if (checkpoints[index].session_id === sessionId) checkpoints.splice(index, 1)
        }
      }
      return { rowsAffected: 0 }
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('PRAGMA')) return [{ ok: 1 }]
      if (sql.includes('FROM checkpoints') && sql.includes('AND turn_index = $2')) {
        const [sessionId, turnIndex] = params as [string, number]
        return checkpoints.filter(
          (checkpoint) => checkpoint.session_id === sessionId && checkpoint.turn_index === turnIndex,
        )
      }
      if (sql.includes('FROM checkpoints')) {
        const [sessionId] = params as [string]
        return checkpoints
          .filter((checkpoint) => checkpoint.session_id === sessionId)
          .sort((left, right) => left.turn_index - right.turn_index)
      }
      return []
    }),
  }
}

let fakeDatabase = createFakeDatabase()
let loadImplementation: () => Promise<unknown> = async () => fakeDatabase

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: () => loadImplementation() },
}))

import { __resetSqliteForTest, createSqlitePersistence } from './sqliteDriver'

beforeEach(() => {
  fakeDatabase = createFakeDatabase()
  loadImplementation = async () => fakeDatabase
  __resetSqliteForTest()
})

afterEach(() => {
  vi.clearAllMocks()
})

const checkpoint = (turnIndex: number, items: Checkpoint['items'] = []): Checkpoint => ({
  turnIndex,
  label: `t${turnIndex}`,
  createdAt: turnIndex * 10,
  items,
})

describe('sqliteHistoryDriver', () => {
  it('round-trips checkpoint kind and existing serialized fields', async () => {
    const { history } = createSqlitePersistence()
    const saved = checkpoint(0, [{ id: 'i0', createdAt: 1, item: { role: 'user', content: 'hi' } }])
    saved.kind = 'working'
    saved.plan = {
      id: 'p1', title: '计划', objective: '验证计划快照', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 1, stages: [],
    }
    saved.recovery = {
      run: { runId: 'running-before-restart', turnId: 'i0', status: 'running' },
    }

    await history.saveCheckpoint('s1', saved)
    await history.saveCheckpoint('s1', checkpoint(1))

    expect((await history.listCheckpoints('s1')).map(({ turnIndex }) => turnIndex)).toEqual([0, 1])
    const loaded = await history.loadCheckpoint('s1', 0)
    expect(loaded).toMatchObject({
      label: 't0', kind: 'working', items: saved.items, plan: saved.plan, recovery: saved.recovery,
    })
    expect(await history.loadCheckpoint('s1', 99)).toBeUndefined()
  })

  it('truncates a session without affecting other sessions', async () => {
    const { history } = createSqlitePersistence()
    for (let index = 0; index < 4; index += 1) await history.saveCheckpoint('s1', checkpoint(index))
    await history.saveCheckpoint('s2', checkpoint(0))

    await history.truncateAfter('s1', 1)
    expect((await history.listCheckpoints('s1')).map(({ turnIndex }) => turnIndex)).toEqual([0, 1])
    await history.deleteSession('s1')
    expect(await history.listCheckpoints('s1')).toEqual([])
    expect((await history.listCheckpoints('s2')).map(({ turnIndex }) => turnIndex)).toEqual([0])
  })

  it('degrades reads and writes when SQLite cannot load', async () => {
    loadImplementation = async () => {
      throw new Error('no tauri runtime')
    }
    const { history } = createSqlitePersistence()
    await expect(history.saveCheckpoint('s1', checkpoint(0))).resolves.toBeUndefined()
    await expect(history.truncateAfter('s1', 0)).resolves.toBeUndefined()
    await expect(history.deleteSession('s1')).resolves.toBeUndefined()
    expect(await history.listCheckpoints('s1')).toEqual([])
    expect(await history.loadCheckpoint('s1', 0)).toBeUndefined()
  })
})
