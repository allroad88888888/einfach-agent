import { beforeEach, describe, expect, it } from 'vitest'
import { fieldLabel } from './dom-field-labels'
import { createDomPageHost } from './dom-host'
import type { PageCallContext } from './types'

beforeEach(() => { document.body.innerHTML = '' })
const labels = (): string[] => Array.from(document.querySelectorAll('input, [role="combobox"]'), fieldLabel)
const ctx: PageCallContext = { sessionId: 'session', signal: new AbortController().signal }

describe('DOM field labels', () => {
  it('reads distinct titles from the nearest real-world form-item shape', async () => {
    document.body.innerHTML = `
      <div class="deepUX-row deepfos-business-form-item"><div class="deepUX-form-item-label"><label><span title="问题标题">问题标题：</span></label></div><div class="deepUX-form-item-control"><div class="deepUX-form-item-control-input"><div class="happy-input"><input placeholder="请输入"></div></div><div role="alert">必填错误</div></div></div>
      <div class="deepUX-row deepfos-business-form-item"><div class="deepUX-form-item-label"><label>问题链接：</label></div><div class="deepUX-form-item-control"><div class="deepUX-form-item-control-input"><input placeholder="请输入"></div><span>填写完整网址</span></div></div>`
    const snapshot = await createDomPageHost({ document, targetId: 'target' }).readForm(ctx)
    expect(snapshot.fields.map((field) => field.label)).toEqual(['问题标题', '问题链接'])
  })

  it('keeps explicit ARIA and label relationships ahead of title and nearby text', () => {
    document.body.innerHTML = `<span id="second">Second</span><span id="first">First</span><div class="form-item"><label>Nearby</label><input id="field" aria-labelledby="first second" title="Title" placeholder="Fallback"></div><label for="named">One</label><label for="named">Two</label><input id="named" title="Ignored">`
    expect(labels()).toEqual(['First Second', 'One Two'])
    document.querySelector('#field')!.setAttribute('aria-label', 'ARIA')
    expect(fieldLabel(document.querySelector('#field')!)).toBe('ARIA')
  })

  it('supports control titles and a standalone combobox form item', () => {
    document.body.innerHTML = `<input title="Direct title" placeholder="请输入"><div class="deepfos-business-form-item"><label><span title="系统环境">环境</span></label><div><div role="combobox"></div></div></div>`
    expect(labels()).toEqual(['Direct title', '系统环境'])
  })

  it('does not cross fields, nested forms, descriptions, errors, or checkbox option labels', () => {
    document.body.innerHTML = `
      <div class="form-item"><label>Shared row</label><input placeholder="First"><input placeholder="Second"></div>
      <div class="form-item"><label>Outer title</label><form><input placeholder="Nested"></form></div>
      <div class="form-item"><div>Description only</div><div role="alert">Bad value</div><input placeholder="Safe fallback"></div>
      <div class="form-item"><label>Preferences</label><div><label><input type="checkbox"> Email updates</label></div></div>`
    expect(labels()).toEqual(['First', 'Second', 'Nested', 'Safe fallback', 'Email updates'])
  })

  it('ignores hidden nearby titles and normalizes required marks and punctuation', () => {
    document.body.innerHTML = `<div class="form-item"><label hidden>Secret</label><label> * Public title：</label><div><input placeholder="请输入"></div></div>`
    expect(labels()).toEqual(['Public title'])
  })
})
