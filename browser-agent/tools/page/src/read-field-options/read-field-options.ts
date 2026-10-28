import type { Tool } from '@einfach-agent/core/tools'
import guide from './read-field-options.md?raw'
import { limitSchema, numberPageSchema, readField } from '../field-tool-support'
import { fail, object, pageRefSchema } from '../tool-support'
import type { PageRef, PageToolsHost } from '../types'

export function createReadFieldOptionsTool(host: PageToolsHost): Tool {
  return {
    name: 'read_field_options', runtime: 'browser',
    skill: { description: '分页读取下拉或受控字段的候选项。', triggers: ['选项', '下拉', 'options'], content: guide },
    inputSchema: { type: 'object', properties: { page: pageRefSchema, fieldId: { type: 'string', minLength: 1 }, query: { type: 'string' }, offset: numberPageSchema, limit: limitSchema }, required: ['page', 'fieldId'], additionalProperties: false },
    execution: { mode: 'parallel', effectKeys: ['page:read'] },
    async execute(args, ctx) {
      try {
        const input = object(args)
        const field = await readField(host, input.page as PageRef, input.fieldId as string, ctx)
        if (field.optionsStatus === 'not-exposed') throw new Error('field options are not exposed in the current DOM')
        const candidates = field.options ?? field.optionLabels?.map((label) => ({ label }))
        if (!candidates) throw new Error('field does not expose options')
        const query = String(input.query ?? '').toLocaleLowerCase()
        const all = query ? candidates.filter((item) => item.label.toLocaleLowerCase().includes(query)
          || ('value' in item && item.value.toLocaleLowerCase().includes(query))) : candidates
        const offset = Number(input.offset ?? 0); const limit = Number(input.limit ?? 20)
        const options = all.slice(offset, offset + limit)
        return { ok: true, data: { page: input.page, fieldId: field.id, options, optionsStatus: field.optionsStatus, ...(offset + options.length < all.length ? { nextOffset: offset + options.length } : {}) } }
      } catch (error) { return fail(error) }
    },
  }
}
