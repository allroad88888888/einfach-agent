import { describe, expect, it } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createClearFieldsTool } from './clear-fields'
import { createDomPageHost } from '../dom-host'
const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
describe('clear_fields', () => { it('clears by value kind and reports single-select partial failure', async () => { document.body.innerHTML = `<input value="text"><input type="checkbox" checked><select multiple><option selected value="a">A</option></select><select><option value="a">A</option></select>`; const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(ctx); const result = await createClearFieldsTool(host).execute({ page: form.page, fieldIds: form.fields.map(({ id }) => id) }, ctx); expect(result).toMatchObject({ ok: true, data: { fields: [{ ok: true, value: '' }, { ok: true, value: false }, { ok: true, value: [] }, { ok: false, error: 'single-select has no empty option' }] } }) }) })
