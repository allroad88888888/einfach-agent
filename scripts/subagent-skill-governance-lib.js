const PROMOTIONS = new Set(['ephemeral', 'candidate', 'promoted', 'archived'])
const MANAGED_SKILL_ID = /^sk_[a-zA-Z0-9_-]{1,92}$/

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function assertPromotion(value, context) {
  if (!PROMOTIONS.has(value)) throw new Error(`${context}: invalid promotion ${JSON.stringify(value)}`)
  return value
}

export function parseSkillIndex(text) {
  const latest = new Map()
  let records = 0

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`skills index line ${index + 1}: invalid JSON (${error.message})`)
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`skills index line ${index + 1}: record must be an object`)
    }
    const skillId = nonEmptyString(record.skillId)
    if (!skillId || !MANAGED_SKILL_ID.test(skillId)) {
      throw new Error(`skills index line ${index + 1}: invalid skillId`)
    }
    assertPromotion(record.promotion, `skills index line ${index + 1}`)
    records += 1
    latest.set(skillId, { ...record, skillId })
  })

  return { records, skills: [...latest.values()] }
}

export function parseSkillFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('skill file must start with YAML frontmatter')
  const closingIndex = lines.indexOf('---', 1)
  if (closingIndex < 0) throw new Error('skill file has unterminated YAML frontmatter')

  const fields = {}
  const fieldLines = {}
  for (let index = 1; index < closingIndex; index += 1) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(lines[index])
    if (!match || (match[1] !== 'skill_id' && match[1] !== 'promotion')) continue
    const [, name, encoded] = match
    if (Object.hasOwn(fields, name)) throw new Error(`skill frontmatter contains duplicate ${name}`)
    try {
      fields[name] = JSON.parse(encoded)
    } catch (error) {
      throw new Error(`skill frontmatter ${name} must be a JSON scalar (${error.message})`)
    }
    fieldLines[name] = index
  }

  const skillId = nonEmptyString(fields.skill_id)
  if (!skillId || !MANAGED_SKILL_ID.test(skillId)) throw new Error('skill frontmatter has invalid skill_id')
  const promotion = assertPromotion(fields.promotion, 'skill frontmatter')
  return { skillId, promotion, promotionLine: fieldLines.promotion, lines }
}

export function updateSkillPromotion(markdown, expectedSkillId, nextPromotion) {
  assertPromotion(nextPromotion, 'requested transition')
  const parsed = parseSkillFrontmatter(markdown)
  if (parsed.skillId !== expectedSkillId) {
    throw new Error(`skill identity mismatch: index=${expectedSkillId}, frontmatter=${parsed.skillId}`)
  }
  const lines = [...parsed.lines]
  lines[parsed.promotionLine] = `promotion: ${JSON.stringify(nextPromotion)}`
  return { text: lines.join('\n'), previousPromotion: parsed.promotion }
}

export function transitionFor(action, currentPromotion) {
  assertPromotion(currentPromotion, 'current skill')
  if (action === 'promote') {
    if (currentPromotion !== 'candidate') throw new Error(`cannot promote skill in ${currentPromotion} state`)
    return 'promoted'
  }
  if (action === 'archive') {
    if (currentPromotion !== 'candidate' && currentPromotion !== 'promoted') {
      throw new Error(`cannot archive skill in ${currentPromotion} state`)
    }
    return 'archived'
  }
  throw new Error(`unsupported governance action: ${action}`)
}

export function candidateSkills(parsedIndex) {
  return parsedIndex.skills.filter((skill) => skill.promotion === 'candidate')
}

export function validateGovernanceAudit(text) {
  let records = 0
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`skill governance audit line ${index + 1}: invalid JSON (${error.message})`)
    }
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.type !== 'skill_governance') {
      throw new Error(`skill governance audit line ${index + 1}: invalid record`)
    }
    if (!nonEmptyString(record.skillId) || !MANAGED_SKILL_ID.test(record.skillId)) {
      throw new Error(`skill governance audit line ${index + 1}: invalid skillId`)
    }
    if (record.action !== 'promote' && record.action !== 'archive') {
      throw new Error(`skill governance audit line ${index + 1}: invalid action`)
    }
    assertPromotion(record.from, `skill governance audit line ${index + 1}`)
    assertPromotion(record.to, `skill governance audit line ${index + 1}`)
    if (!nonEmptyString(record.at)) throw new Error(`skill governance audit line ${index + 1}: invalid timestamp`)
    records += 1
  })
  return { records }
}

export function appendGovernanceRecords({ indexText, auditText, record, action, from, to, at }) {
  const nextRecord = {
    ...record,
    promotion: to,
    governanceAction: action,
    governanceAt: at,
  }
  const auditRecord = {
    type: 'skill_governance',
    skillId: record.skillId,
    action,
    from,
    to,
    at,
    source: 'manual_cli',
  }
  const append = (text, value) => `${text && !text.endsWith('\n') ? `${text}\n` : text}${JSON.stringify(value)}\n`
  return {
    indexText: append(indexText, nextRecord),
    auditText: append(auditText, auditRecord),
    nextRecord,
    auditRecord,
  }
}

export function assertIndexMatchesFrontmatter(record, frontmatter) {
  if (record.skillId !== frontmatter.skillId) {
    throw new Error(`skill identity mismatch: index=${record.skillId}, frontmatter=${frontmatter.skillId}`)
  }
  if (record.promotion !== frontmatter.promotion) {
    throw new Error(
      `skill promotion mismatch for ${record.skillId}: index=${record.promotion}, frontmatter=${frontmatter.promotion}`,
    )
  }
}

export const SUBAGENT_SKILL_PROMOTIONS = Object.freeze([...PROMOTIONS])
