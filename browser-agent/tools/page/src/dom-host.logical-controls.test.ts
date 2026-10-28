import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomPageHost } from './dom-host'
import type { ControlledFieldAdapter, PageCallContext } from './types'

const ctx: PageCallContext = { sessionId: 'logical', signal: new AbortController().signal }
beforeEach(() => { document.body.innerHTML = '' })

const item = (label: string, control: string, required = false): string =>
  `<section class="form-item"><div><label title="${label}"><em class="${required ? 'field_required_mark' : ''}">${label}</em></label></div><div>${control}</div></section>`

const appendEditor = (container: Element, text: string): void => {
  const frame = document.createElement('iframe'); frame.title = 'Rich text area'; container.append(frame)
  const body = frame.contentDocument!.body; body.setAttribute('contenteditable', 'true')
  body.innerHTML = `${text}<span hidden>hidden editor text</span><textarea>technical secret</textarea>`
}

describe('DOM logical form controls', () => {
  it('enumerates the 13-field page shape without component-name dependencies', async () => {
    document.body.innerHTML = `<main>
      ${item('问题标题', '<input value="标题">', true)}
      ${item('问题链接', '<input value="https://example.test">')}
      ${item('工单类型', '<div class="selector-shell"><div class="focus-root" tabindex="1"><div class="placeholder-state">请选择</div></div></div>', true)}
      ${item('相关产品组件', '<div><div class="focus-root choice-multiple" tabindex="0"><span>组件甲</span><span>组件乙</span></div></div>')}
      ${item('所属部门', '<div><div class="focus-root" tabindex="0"><span>研发部</span><input type="hidden" value="secret-id"></div></div>')}
      ${item('相关项目', '<div><div class="focus-root" tabindex="0"><span class="placeholder-state">请选择项目</span></div></div>')}
      ${item('紧急', '<input type="checkbox" checked>')}${item('重要', '<input type="checkbox">')}${item('一般', '<input type="checkbox">')}
      ${item('相关附件', '<input type="file">')}
      ${item('系统环境', '<div role="combobox" tabindex="0"><span class="placeholder-state">请选择</span></div>')}
      ${item('问题描述', '<div id="editor-a"></div>', true)}${item('解决方案', '<div id="editor-b"></div>')}
    </main>`
    appendEditor(document.querySelector('#editor-a')!, '可见描述'); appendEditor(document.querySelector('#editor-b')!, '可见方案')
    const fields = (await createDomPageHost({ document, targetId: 'page' }).readForm(ctx)).fields
    expect(fields).toHaveLength(13)
    expect(fields.map(({ label }) => label)).toEqual(['问题标题', '问题链接', '工单类型', '相关产品组件', '所属部门', '相关项目', '紧急', '重要', '一般', '相关附件', '系统环境', '问题描述', '解决方案'])
    expect(fields[2]).toMatchObject({ kind: 'custom-select', value: '', required: true, readOnly: false, supported: false, optionsStatus: 'not-exposed' })
    expect(fields[3]).toMatchObject({ kind: 'custom-multiple', value: ['组件甲', '组件乙'] })
    expect(fields[4].value).toBe('研发部')
    expect(fields[10]).toMatchObject({ kind: 'combobox', value: '', readOnly: false, supported: false })
    expect(fields.slice(11).map(({ kind, value }) => ({ kind, value }))).toEqual([{ kind: 'richtext', value: '可见描述' }, { kind: 'richtext', value: '可见方案' }])
  })

  it('supports unclassed groups outside forms and rejects unrelated focus targets', async () => {
    document.body.innerHTML = `<main><section><label>Framework</label><div><div tabindex="0" aria-placeholder="Choose"><span data-placeholder>Choose</span></div></div></section>
      <section><label>Selected framework</label><div tabindex="0" data-placeholder="Choose"><span data-placeholder>Choose</span><span>React</span></div></section>
      <nav><div tabindex="0"><span>Navigation</span></div></nav><button tabindex="0">Button</button>
      <section><label>Wrapped native</label><div tabindex="0"><input value="native"></div></section></main>`
    const fields = (await createDomPageHost({ document, targetId: 'generic' }).readForm(ctx)).fields
    expect(fields.map(({ label, kind, value }) => ({ label, kind, value }))).toEqual([
      { label: 'Framework', kind: 'custom-select', value: '' },
      { label: 'Selected framework', kind: 'custom-select', value: 'React' },
      { label: 'Wrapped native', kind: 'text', value: 'native' },
    ])
  })

  it('does not read nested popup candidates as single or multiple current values', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Single"><div class="popup-wrap"><div role="listbox"><div role="option">Alpha</div><div role="option" aria-selected="true" data-value="hidden-beta" hidden>Beta</div></div></div></div>
      <div role="combobox" aria-label="Many" aria-multiselectable="true"><span data-placeholder>Choose</span><div><div role="tree"><div role="treeitem">One</div><div aria-hidden="true"><div role="treeitem" aria-selected="true" data-value="hidden-two">Two</div></div></div></div></div>`
    const fields = (await createDomPageHost({ document, targetId: 'nested-popup' }).readForm(ctx)).fields
    expect(fields.map(({ value }) => value)).toEqual(['', []])
  })

  it('reads linked options without treating a portal as another field or all options as a value', async () => {
    document.body.innerHTML = `<label for="city">City</label><input id="city" role="combobox" aria-controls="cities" value="typed">
      <div id="cities" role="listbox"><div role="option" data-value="sha">Shanghai</div><div role="option" aria-disabled="true"><span>Beijing</span><span hidden>secret</span></div></div>
      <div role="listbox" aria-label="Standalone" aria-required="true" aria-disabled="true"><div role="option" data-value="a">Alpha</div></div>`
    const fields = (await createDomPageHost({ document, targetId: 'aria' }).readForm(ctx)).fields
    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatchObject({ kind: 'text', value: 'typed', optionLabels: ['Shanghai', 'Beijing'], optionsStatus: 'exposed' })
    expect(fields[1]).toMatchObject({ kind: 'listbox', value: '', required: true, readOnly: true, options: [{ label: 'Alpha', value: 'a' }] })
  })

  it('deduplicates composite controls, preserves adapter priority, and dispatches no read events', async () => {
    document.body.innerHTML = `${item('Searchable', '<div data-widget tabindex="0" aria-label="Internal"><div data-widget><input value="hidden search"></div></div>')}<select><option>A</option></select><input role="combobox" aria-controls="missing-popup" list="suggestions"><datalist id="suggestions"><option value="x" label="X-ray"></datalist>`
    const adapter: ControlledFieldAdapter = { kind: 'widget', matches: (element) => element.hasAttribute('data-widget'), read: () => ({ label: 'Searchable', value: 'chosen', required: false, readOnly: false, supported: true }), write() {} }
    const events = ['click', 'input', 'change'].map((name) => { const spy = vi.fn(); document.addEventListener(name, spy); return spy })
    const fields = (await createDomPageHost({ document, targetId: 'adapter', controlledAdapters: [adapter] }).readForm(ctx)).fields
    expect(fields).toHaveLength(3); expect(fields[0]).toMatchObject({ kind: 'widget', value: 'chosen' })
    expect(fields[1]).toMatchObject({ options: [{ label: 'A', value: 'A' }], optionsStatus: 'exposed' })
    expect(fields[2]).toMatchObject({ options: [{ label: 'X-ray', value: 'x' }], optionsStatus: 'exposed' })
    expect(events.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('ignores inaccessible iframe documents and keeps other controls readable', async () => {
    const frame = document.createElement('iframe')
    Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => { throw new DOMException('Blocked', 'SecurityError') } })
    document.body.append(frame); document.body.insertAdjacentHTML('beforeend', '<input aria-label="Safe" value="ok">')
    const fields = (await createDomPageHost({ document, targetId: 'cross-origin' }).readForm(ctx)).fields
    expect(fields.map(({ label, value }) => ({ label, value }))).toEqual([{ label: 'Safe', value: 'ok' }])
  })
})
