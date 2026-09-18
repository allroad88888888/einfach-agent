import { describe, expect, it } from 'vitest'
import { isAgentProfileSnapshot } from './agentProfileSchema'

const valid = {
  agentId: 'agent', revision: 1, instructions: 'do it', connectionId: 'connection',
  skillContents: [{ name: 'skill', revision: 1, description: 'desc', triggers: ['go'], content: 'body', resources: { 'ref.md': 'ref' } }],
}

describe('agent profile persistence schema', () => {
  it('accepts the exact current shape', () => expect(isAgentProfileSnapshot(valid)).toBe(true))

  it.each([
    { ...valid, skillContents: 'bad' },
    { ...valid, future: true },
    { ...valid, skillContents: [{ ...valid.skillContents[0], resources: { x: 1 } }] },
    { ...valid, revision: 0 },
  ])('rejects malformed and future shapes', (value) => expect(isAgentProfileSnapshot(value)).toBe(false))
})
