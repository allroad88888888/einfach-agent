import { describe, expect, it } from 'vitest'
import {
  formatServerReadyFrame,
  SERVER_READY_KIND,
  SERVER_READY_VERSION,
  type ServerReadyFrame,
} from './mainReadyFrame'

describe('formatServerReadyFrame', () => {
  it('输出一行带结尾换行的 JSON，并且只包含协议字段', () => {
    const frame: ServerReadyFrame = {
      kind: SERVER_READY_KIND,
      version: SERVER_READY_VERSION,
      url: 'http://127.0.0.1:4765/?token=test-token',
    }

    const output = formatServerReadyFrame(frame)
    const lines = output.split('\n')

    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('')
    expect(JSON.parse(lines[0] ?? '')).toEqual(frame)
    expect(Object.keys(JSON.parse(lines[0] ?? ''))).toEqual(['kind', 'version', 'url'])
  })
})
