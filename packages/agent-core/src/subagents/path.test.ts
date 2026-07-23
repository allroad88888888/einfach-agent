import { describe, expect, it } from 'vitest'
import {
  ROOT_AGENT_PATH,
  agentPathDepth,
  childAgentPath,
  compareAgentPaths,
  isAgentPath,
  parentAgentPath,
  parseAgentPath,
} from './path'

describe('subagent path', () => {
  it('uses root plus padded ordinal segments', () => {
    expect(ROOT_AGENT_PATH).toBe('root')
    expect(childAgentPath(ROOT_AGENT_PATH, 1)).toBe('root-01')
    expect(childAgentPath('root-01', 2)).toBe('root-01-02')
    expect(childAgentPath('root-01', 12)).toBe('root-01-12')
  })

  it('parses and validates generated paths', () => {
    expect(parseAgentPath('root')).toEqual([])
    expect(parseAgentPath('root-01-02')).toEqual([1, 2])
    expect(isAgentPath('root-01-02')).toBe(true)
    expect(isAgentPath('root-00')).toBe(false)
    expect(isAgentPath('01')).toBe(false)
    expect(isAgentPath('root-a')).toBe(false)
  })

  it('computes parent and depth', () => {
    expect(agentPathDepth('root')).toBe(0)
    expect(agentPathDepth('root-01-02')).toBe(2)
    expect(parentAgentPath('root')).toBeUndefined()
    expect(parentAgentPath('root-01')).toBe('root')
    expect(parentAgentPath('root-01-02')).toBe('root-01')
  })

  it('sorts by numeric tree order instead of lexical order', () => {
    const paths = ['root-10', 'root-02', 'root-01-01', 'root-01', 'root'] as const

    expect([...paths].sort(compareAgentPaths)).toEqual([
      'root',
      'root-01',
      'root-01-01',
      'root-02',
      'root-10',
    ])
  })
})
