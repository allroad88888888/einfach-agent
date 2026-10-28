import type { Tool } from '@einfach-agent/core/tools'
import guide from './wait-for-field.md?raw'
import { readField } from '../field-tool-support'
import { fail, object, pageRefSchema, valueSchema } from '../tool-support'
import type { FieldValue, PageRef, PageToolsHost } from '../types'

const equal = (left: FieldValue, right: FieldValue): boolean => Array.isArray(left) && Array.isArray(right)
  ? left.length === right.length && left.every((value) => right.includes(value)) : left === right

function until<T>(promise: Promise<T>, end: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); action() }
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for field'))), Math.max(0, end - Date.now()))
    const abort = () => finish(() => reject(new DOMException('The operation was aborted', 'AbortError')))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then((value) => finish(() => Date.now() >= end ? reject(new Error('timed out waiting for field')) : resolve(value)), (error) => finish(() => reject(error)))
  })
}
const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms)
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('The operation was aborted', 'AbortError')) }
  function done() { signal.removeEventListener('abort', abort); resolve() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
})

export function createWaitForFieldTool(host: PageToolsHost): Tool {
  return {
    name: 'wait_for_field', runtime: 'browser',
    skill: { description: '等待字段可填写、出现选项或达到指定值。', triggers: ['等待字段', '选项加载', 'wait'], content: guide },
    inputSchema: { type: 'object', properties: { page: pageRefSchema, fieldId: { type: 'string', minLength: 1 }, condition: { enum: ['ready', 'options', 'value'] }, value: valueSchema, timeoutMs: { type: 'integer', minimum: 1, maximum: 30_000 } }, required: ['page', 'fieldId', 'condition'], additionalProperties: false },
    execution: { mode: 'parallel', effectKeys: ['page:read'] },
    async execute(args, ctx) {
      try {
        const input = object(args)
        if (input.condition === 'value' && input.value === undefined) throw new Error('value is required for the value condition')
        const end = Date.now() + Number(input.timeoutMs ?? 5_000); const controller = new AbortController()
        const abort = () => controller.abort(); ctx.signal.addEventListener('abort', abort, { once: true })
        if (ctx.signal.aborted) abort()
        const deadline = setTimeout(() => controller.abort(), Math.max(0, end - Date.now()))
        try {
          while (true) {
            const field = await until(readField(host, input.page as PageRef, input.fieldId as string, { ...ctx, signal: controller.signal }), end, controller.signal)
            const met = input.condition === 'ready' ? field.supported && !field.readOnly : input.condition === 'options' ? Boolean(field.options?.length) : equal(field.value, input.value as FieldValue)
            if (met && Date.now() < end) return { ok: true, data: { page: input.page, field } }
            await pause(Math.min(100, Math.max(0, end - Date.now())), controller.signal)
          }
        } finally { clearTimeout(deadline); ctx.signal.removeEventListener('abort', abort); controller.abort() }
      } catch (error) { return fail(error) }
    },
  }
}
