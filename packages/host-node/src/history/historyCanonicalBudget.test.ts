import { describe, expect, it, vi } from 'vitest'
import { fitCanonicalWarnings } from './historyCanonicalBudget'
import type { AgentHistoryWarning } from '@einfach-agent/core/history'

const projection = [{ code: 'PROJECTION_LAG' as const, message: 'lag' }]
describe('canonical service warning budget', () => {
  it('requeries with a smaller source limit and retains its cursor', async () => {
    const values = ['x'.repeat(49_990), 'y'.repeat(49_990)]
    interface Result { values: string[]; warnings: AgentHistoryWarning[]; nextCursor?: string }
    const query = vi.fn(async (limit: number): Promise<Result> => ({ values: values.slice(0, limit), warnings: [], nextCursor: 'source-cursor' }))
    const initial: Result = { values, warnings: [] }
    const result = await fitCanonicalWarnings(initial, value => value.values.length, query, projection)
    expect(result.values).toHaveLength(1); expect(result.nextCursor).toBe('source-cursor')
    expect(result.warnings.map(value => value.code)).toEqual(['PROJECTION_LAG', 'OUTPUT_TRUNCATED'])
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000)
  })

  it.each(['items', 'hits'] as const)('keeps canonical %s source cursor when service warnings force truncation', async (field) => {
    const values = ['x'.repeat(49_990), 'y'.repeat(49_990)]
    type Result = { items?: string[]; hits?: string[]; warnings: AgentHistoryWarning[]; nextCursor?: string }
    const make = (limit: number): Result => ({ [field]: values.slice(0, limit), warnings: [], nextCursor: `${field}-cursor` })
    const initial = make(2); delete initial.nextCursor
    const result = await fitCanonicalWarnings(initial, value => (value[field] ?? []).length,
      async limit => make(limit), projection)
    expect(result[field]).toHaveLength(1); expect(result.nextCursor).toBe(`${field}-cursor`)
    expect(result.warnings.map(value => value.code)).toEqual(['PROJECTION_LAG', 'OUTPUT_TRUNCATED'])
  })
})
