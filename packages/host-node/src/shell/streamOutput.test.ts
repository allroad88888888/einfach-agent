import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { executeShellCommand } from './pipeline'
import { currentPlatform } from './platform'
import { captureOutput } from './outputCapture'

const platform = currentPlatform()
const run = (command: string, signal?: AbortSignal, output?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void, maxOutputChars = 100) =>
  executeShellCommand({ platform, command, maxOutputChars }, signal, output)

describe.skipIf(process.platform === 'win32')('private shell output', () => {
  it('publishes stdout/stderr while the real child is still running', async () => {
    let settled = false
    let firstAt = 0
    const chunks: { stream: string; text: string }[] = []
    const result = await run('printf first; sleep 0.2; printf second >&2; sleep 0.2', undefined, (chunk) => {
      expect(settled).toBe(false)
      if (!firstAt) firstAt = performance.now()
      chunks.push(chunk)
    }).then((value) => { settled = true; return value })
    expect(chunks).toContainEqual({ stream: 'stdout', text: 'first' })
    expect(chunks).toContainEqual({ stream: 'stderr', text: 'second' })
    expect(performance.now() - firstAt).toBeGreaterThan(250)
    expect(result.stdout).toBe('first')
    expect(result.stderr).toBe('second')
  }, 20_000)

  it('caps incremental text but drains a large real child to successful exit', async () => {
    let text = ''
    const result = await run('yes output | head -c 300000', undefined, (chunk) => { text += chunk.text }, 7)
    expect(text).toHaveLength(7)
    expect(result.stdout).toHaveLength(7)
    expect(result.exit_code).toBe(0)
    expect(result.truncated).toBe(true)
  }, 20_000)

  it('keeps concurrent children isolated and stops callbacks after cancellation', async () => {
    const controller = new AbortController()
    let a = '', b = ''
    const first = run('printf private-a; sleep 20; printf late', controller.signal, (chunk) => {
      a += chunk.text
      controller.abort()
    })
    const second = run('printf private-b', undefined, (chunk) => { b += chunk.text })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect((await second).exit_code).toBe(0)
    expect(a).toBe('private-a')
    expect(b).toBe('private-b')
  }, 20_000)

  it('decodes split UTF-8 and preserves the code-point cap', async () => {
    const bytes = Buffer.from('😀中尾')
    const chunks: string[] = []
    const capture = captureOutput(Readable.from([...bytes].map((byte) => Buffer.from([byte]))), 'stdout', 2, undefined, (chunk) => chunks.push(chunk.text))
    await capture.done
    expect(chunks.join('')).toBe('😀中')
    expect(capture.take()).toEqual({ text: '😀中', truncated: true })
  })
})
