import { describe, expect, it } from 'vitest'
import { createPickWorkspaceDirectoryHandler } from './pickWorkspaceDirectoryHandler'

describe('pick workspace directory handler', () => {
  it('returns the selected directory through the JSON-safe command response', async () => {
    const handler = createPickWorkspaceDirectoryHandler({ openWorkspaceDirectory: async () => '/Users/me/project' })
    await expect(handler({})).resolves.toEqual({ path: '/Users/me/project' })
  })

  it('keeps cancellation explicit as null', async () => {
    const handler = createPickWorkspaceDirectoryHandler({ openWorkspaceDirectory: async () => undefined })
    await expect(handler({})).resolves.toEqual({ path: null })
  })
})
