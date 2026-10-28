import { expect, it } from 'vitest'
import { classifyToolRisk, isDelegatableDangerousTool } from './dangerousTools'
import { commandUsesPermanentDelete } from './shellCommandRisk'
import { classifyToolReversibility } from './toolReversibility'
it('services use shell command-level critical protection and remain root-only', () => {
  expect(classifyToolRisk('start_service', { command: 'rm -rf /' })).toMatchObject({ level: 'critical', requiresConfirmation: true })
  expect(classifyToolRisk('start_service', { command: 'mkfs.ext4 /dev/test' }).level).toBe('critical')
  expect(classifyToolRisk('start_service', { command: 'dd if=/dev/zero of=/dev/test' }).level).toBe('critical')
  expect(classifyToolRisk('start_service', { command: 'npm run dev' }).level).toBe('dangerous')
  expect(commandUsesPermanentDelete('start_service', { command: 'rm file' })).toBe(true)
  expect(isDelegatableDangerousTool('start_service')).toBe(false)
  expect(classifyToolRisk('stop_service', {}).level).toBe('dangerous')
  expect(classifyToolRisk('read_service_logs', {}).level).toBe('safe')
  expect(classifyToolReversibility('get_service_status')).toBe('pure')
  expect(classifyToolReversibility('read_service_logs')).toBe('pure')
  expect(classifyToolReversibility('start_service')).toBe('irreversible')
})
