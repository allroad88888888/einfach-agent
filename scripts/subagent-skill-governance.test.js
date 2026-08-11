import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const cli = resolve(process.cwd(), 'scripts/subagent-skill-governance.js')

async function fixture({ malformed = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'subagent-skills-'))
  const indexRoot = join(base, '.webAgent-archive', 'index')
  const skillRoot = join(base, '.webAgent-archive', 'skills')
  await mkdir(indexRoot, { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  const record = { skillId: 'sk_one', promotion: 'candidate', kind: 'core', summary: 'candidate one' }
  await writeFile(join(indexRoot, 'skills.jsonl'), malformed ? '{bad\n' : `${JSON.stringify(record)}\n`)
  await writeFile(
    join(skillRoot, 'sk_one.md'),
    '---\nskill_id: "sk_one"\nkind: "core"\npromotion: "candidate"\n---\n\nbody\n',
  )
  return base
}

async function governanceState(base) {
  const archiveRoot = join(base, '.webAgent-archive')
  const indexLines = (await readFile(join(archiveRoot, 'index', 'skills.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
  const auditText = await readFile(join(archiveRoot, 'governance', 'skill-actions.jsonl'), 'utf8')
  const auditLines = auditText.trim() ? auditText.trim().split('\n').map(JSON.parse) : []
  return {
    skill: await readFile(join(archiveRoot, 'skills', 'sk_one.md'), 'utf8'),
    indexLines,
    auditLines,
  }
}

describe('subagent skill governance CLI', () => {
  it('is read-only by default and requires --write for mutation', async () => {
    const base = await fixture()
    const before = await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')
    const listed = await execFileAsync(process.execPath, [cli, '--base', base])
    expect(listed.stdout).toContain('sk_one\tcore\tcandidate one')
    await expect(execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one'])).rejects.toMatchObject({
      stderr: expect.stringContaining('repeat with --write'),
    })
    expect(await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')).toBe(before)
  })

  it('rejects contradictory explicit actions instead of silently falling back to list', async () => {
    const base = await fixture()
    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--list']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('choose exactly one') })
    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--list', '--archive', 'sk_one', '--write']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('choose exactly one') })
  })

  it('promotes one explicit skill and writes index plus audit records', async () => {
    const base = await fixture()
    const result = await execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'])
    expect(result.stdout).toContain('candidate -> promoted')
    expect(await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')).toContain(
      'promotion: "promoted"',
    )
    const indexLines = (await readFile(join(base, '.webAgent-archive', 'index', 'skills.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    expect(indexLines.at(-1)).toMatchObject({ skillId: 'sk_one', promotion: 'promoted', governanceAction: 'promote' })
    const audit = JSON.parse(await readFile(join(base, '.webAgent-archive', 'governance', 'skill-actions.jsonl'), 'utf8'))
    expect(audit).toMatchObject({ skillId: 'sk_one', action: 'promote', from: 'candidate', to: 'promoted' })
  })

  it('archives a promoted skill as a second explicit audited transition', async () => {
    const base = await fixture()
    await execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'])
    await execFileAsync(process.execPath, [cli, '--base', base, '--archive', 'sk_one', '--write'])

    expect(await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')).toContain(
      'promotion: "archived"',
    )
    const auditLines = (await readFile(join(base, '.webAgent-archive', 'governance', 'skill-actions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    expect(auditLines).toHaveLength(2)
    expect(auditLines.at(-1)).toMatchObject({ action: 'archive', from: 'promoted', to: 'archived' })
  })

  it('fails closed before writing when any index line is malformed', async () => {
    const base = await fixture({ malformed: true })
    const path = join(base, '.webAgent-archive', 'skills', 'sk_one.md')
    const before = await readFile(path, 'utf8')
    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('invalid JSON') })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('fails closed without changing state when the existing audit is malformed', async () => {
    const base = await fixture()
    const governanceRoot = join(base, '.webAgent-archive', 'governance')
    await mkdir(governanceRoot, { recursive: true })
    await writeFile(join(governanceRoot, 'skill-actions.jsonl'), '{bad\n')
    const path = join(base, '.webAgent-archive', 'skills', 'sk_one.md')
    const before = await readFile(path, 'utf8')
    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('audit line 1: invalid JSON') })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it.each([
    'journal_prepared',
    'state_committing',
    'write_skill',
    'apply_skill',
    'write_index',
    'apply_index',
    'write_audit',
    'apply_audit',
    'state_committed',
  ])('recovers idempotently after a process crash at %s', async (stage) => {
    const base = await fixture()
    await expect(execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'], {
      env: { ...process.env, SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER: stage },
    })).rejects.toMatchObject({ code: 86 })

    const journalPath = join(base, '.webAgent-archive', 'governance', 'skill-transaction.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    if (stage === 'state_committed') expect(journal.state).toBe('committed')
    else expect(['prepared', 'committing']).toContain(journal.state)

    const recovery = execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'])
    if (stage === 'state_committed') {
      await expect(recovery).rejects.toMatchObject({ stderr: expect.stringContaining('cannot promote') })
    } else {
      await expect(recovery).resolves.toMatchObject({ stdout: expect.stringContaining('candidate -> promoted') })
    }

    const state = await governanceState(base)
    expect(state.skill).toContain('promotion: "promoted"')
    expect(state.indexLines.filter((record) => record.governanceAction === 'promote')).toHaveLength(1)
    expect(state.auditLines).toHaveLength(1)
    expect(state.auditLines[0]).toMatchObject({ action: 'promote', from: 'candidate', to: 'promoted' })
    await expect(access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'recovery_rolling_back',
    'recovery_audit',
    'recovery_index',
    'recovery_skill',
    'recovery_rolled_back',
  ])('can crash again during %s and safely resume recovery', async (recoveryStage) => {
    const base = await fixture()
    const args = [cli, '--base', base, '--promote', 'sk_one', '--write']
    await expect(execFileAsync(process.execPath, args, {
      env: { ...process.env, SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER: 'write_index' },
    })).rejects.toMatchObject({ code: 86 })
    await expect(execFileAsync(process.execPath, args, {
      env: { ...process.env, SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER: recoveryStage },
    })).rejects.toMatchObject({ code: 86 })
    await expect(execFileAsync(process.execPath, args)).resolves.toMatchObject({
      stdout: expect.stringContaining('candidate -> promoted'),
    })

    const state = await governanceState(base)
    expect(state.indexLines.filter((record) => record.governanceAction === 'promote')).toHaveLength(1)
    expect(state.auditLines).toHaveLength(1)
  })

  it('coordinates with the runtime archive-write lock before starting a transaction', async () => {
    const base = await fixture()
    const indexPath = join(base, '.webAgent-archive', 'index', 'skills.jsonl')
    const sharedLockPath = `${indexPath}.archive-write.lock`
    await writeFile(sharedLockPath, `${process.pid}-${Date.now()}`)
    const mutation = execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'])
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    expect(await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')).toContain(
      'promotion: "candidate"',
    )
    await unlink(sharedLockPath)
    await expect(mutation).resolves.toMatchObject({ stdout: expect.stringContaining('candidate -> promoted') })
  })

  it('fails closed when a pending transaction journal is malformed', async () => {
    const base = await fixture()
    const governanceRoot = join(base, '.webAgent-archive', 'governance')
    await mkdir(governanceRoot, { recursive: true })
    await writeFile(join(governanceRoot, 'skill-transaction.json'), '{bad\n')
    const before = await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')

    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('governance recovery refused') })
    expect(await readFile(join(base, '.webAgent-archive', 'skills', 'sk_one.md'), 'utf8')).toBe(before)
  })

  it('keeps default listing read-only and fails closed while recovery is pending', async () => {
    const base = await fixture()
    await expect(execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'], {
      env: { ...process.env, SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER: 'journal_prepared' },
    })).rejects.toMatchObject({ code: 86 })
    const journalPath = join(base, '.webAgent-archive', 'governance', 'skill-transaction.json')
    const before = await readFile(journalPath, 'utf8')

    await expect(execFileAsync(process.execPath, [cli, '--base', base])).rejects.toMatchObject({
      stderr: expect.stringContaining('pending governance transaction requires recovery'),
    })
    expect(await readFile(journalPath, 'utf8')).toBe(before)
  })

  it('refuses recovery when a target changed outside the pending transaction', async () => {
    const base = await fixture()
    await expect(execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write'], {
      env: { ...process.env, SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER: 'apply_skill' },
    })).rejects.toMatchObject({ code: 86 })
    const indexPath = join(base, '.webAgent-archive', 'index', 'skills.jsonl')
    await writeFile(indexPath, `${await readFile(indexPath, 'utf8')}{"skillId":"sk_other","promotion":"candidate"}\n`)

    await expect(
      execFileAsync(process.execPath, [cli, '--base', base, '--promote', 'sk_one', '--write']),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('index changed outside the pending transaction') })
  })
})
