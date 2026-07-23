import { describe, expect, it } from 'vitest'
import {
  appendGovernanceRecords,
  assertIndexMatchesFrontmatter,
  candidateSkills,
  parseSkillFrontmatter,
  parseSkillIndex,
  transitionFor,
  updateSkillPromotion,
  validateGovernanceAudit,
} from './subagent-skill-governance-lib.js'

const markdown = (skillId = 'sk_one', promotion = 'candidate') =>
  `---\nskill_id: ${JSON.stringify(skillId)}\nkind: "core"\npromotion: ${JSON.stringify(promotion)}\n---\n\nbody\n`

describe('subagent skill governance library', () => {
  it('lists only latest candidate index records', () => {
    const parsed = parseSkillIndex(
      [
        JSON.stringify({ skillId: 'sk_one', promotion: 'candidate' }),
        JSON.stringify({ skillId: 'sk_two', promotion: 'candidate' }),
        JSON.stringify({ skillId: 'sk_one', promotion: 'promoted' }),
      ].join('\n'),
    )
    expect(parsed.records).toBe(3)
    expect(candidateSkills(parsed).map((skill) => skill.skillId)).toEqual(['sk_two'])
  })

  it('fails closed on malformed index and frontmatter', () => {
    expect(() => parseSkillIndex('{bad')).toThrow('invalid JSON')
    expect(() => parseSkillIndex('{"skillId":"../outside","promotion":"candidate"}')).toThrow('invalid skillId')
    expect(() => parseSkillFrontmatter('---\nskill_id: "sk_one"\n---\n')).toThrow('invalid promotion')
    expect(() => parseSkillFrontmatter('---\nskill_id: "sk_one"\npromotion: candidate\n---\n')).toThrow(
      'must be a JSON scalar',
    )
  })

  it('updates only promotion and checks index/frontmatter consistency', () => {
    const updated = updateSkillPromotion(markdown(), 'sk_one', 'promoted')
    expect(updated.previousPromotion).toBe('candidate')
    expect(updated.text).toBe(markdown('sk_one', 'promoted'))
    expect(() => updateSkillPromotion(markdown(), 'sk_other', 'promoted')).toThrow('identity mismatch')
    expect(() =>
      assertIndexMatchesFrontmatter(
        { skillId: 'sk_one', promotion: 'promoted' },
        parseSkillFrontmatter(markdown()),
      ),
    ).toThrow('promotion mismatch')
  })

  it('enforces explicit one-way transitions', () => {
    expect(transitionFor('promote', 'candidate')).toBe('promoted')
    expect(transitionFor('archive', 'candidate')).toBe('archived')
    expect(transitionFor('archive', 'promoted')).toBe('archived')
    expect(() => transitionFor('promote', 'promoted')).toThrow('cannot promote')
    expect(() => transitionFor('archive', 'archived')).toThrow('cannot archive')
  })

  it('appends a searchable latest index record and durable audit record', () => {
    const result = appendGovernanceRecords({
      indexText: '{"skillId":"sk_one","promotion":"candidate"}\n',
      auditText: '',
      record: { skillId: 'sk_one', promotion: 'candidate', summary: 'x' },
      action: 'promote',
      from: 'candidate',
      to: 'promoted',
      at: '2026-07-21T00:00:00.000Z',
    })
    expect(parseSkillIndex(result.indexText).skills[0]).toMatchObject({
      skillId: 'sk_one',
      promotion: 'promoted',
      governanceAction: 'promote',
    })
    expect(JSON.parse(result.auditText)).toMatchObject({
      type: 'skill_governance',
      action: 'promote',
      from: 'candidate',
      to: 'promoted',
    })
    expect(validateGovernanceAudit(result.auditText)).toEqual({ records: 1 })
    expect(() => validateGovernanceAudit('{bad\n')).toThrow('invalid JSON')
  })
})
