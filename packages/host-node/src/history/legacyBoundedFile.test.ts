import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readLegacyBoundedFile } from './legacyBoundedFile'

let roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('readLegacyBoundedFile', () => {
  it('reports actual bytes from a single bounded handle read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-bounded-')); roots.push(root)
    const path = join(root, 'value')
    await writeFile(path, '😀x')
    await expect(readLegacyBoundedFile(path, 5)).resolves.toMatchObject({ status: 'ok', bytesRead: 5, text: '😀x' })
  })

  it('reads only cap+1 for an oversized file and distinguishes missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-bounded-')); roots.push(root)
    const path = join(root, 'large')
    await writeFile(path, 'x'.repeat(100))
    await expect(readLegacyBoundedFile(path, 7)).resolves.toMatchObject({ status: 'oversized', bytesRead: 8 })
    await expect(readLegacyBoundedFile(join(root, 'missing'), 7)).resolves.toEqual({ status: 'missing' })
  })
})
