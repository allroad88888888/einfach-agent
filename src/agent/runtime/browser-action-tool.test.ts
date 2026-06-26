import { createStore } from '@einfach/core'
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeBrowserCardsAtom,
  activeMessagesAtom,
  activeRunAtom,
  activeTimelineAtom,
  browserCardsBySessionAtom,
} from '../state/atoms'
import { mockRenderCardControl } from '../model/mock-adapter'
import { formatRenderCardResult, normalizeBrowserCardPayload, startAgentRun } from './loop'

function totalCards(store: ReturnType<typeof createStore>) {
  return Object.values(store.getter(browserCardsBySessionAtom)).reduce(
    (sum, list) => sum + (list?.length ?? 0),
    0,
  )
}

// browser_action render_card driven through the REAL lazy-tool two-stage path.
// The mock adapter is triggered by the `render card` phrase: request schema ->
// submit render_card payload -> final assistant message.
describe('browser_action render_card (lazy-tool real path)', () => {
  afterEach(() => {
    mockRenderCardControl.renderCardPayloadGate = undefined
  })

  it('writes the card into the atom, returns accepted+cardId, echoes card content, and appends NO tool-authored assistant message', async () => {
    const store = createStore()

    startAgentRun(store, '渲染卡片 render card demo')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    // (1) card landed in the atom
    const cards = store.getter(activeBrowserCardsAtom)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      title: '部署方案对比',
      items: ['方案 A', '方案 B'],
      options: ['选 A', '选 B'],
    })
    expect(typeof cards[0].id).toBe('string')
    expect(typeof cards[0].createdAt).toBe('number')

    // (2) timeline: two-stage protocol + accepted result that ECHOES the card
    //     content (BF2 — the model always sees what it rendered).
    const timeline = store.getter(activeTimelineAtom)
    expect(timeline.some((event) => event.title === 'load browser_action')).toBe(true)
    const callEvent = timeline.find((event) => event.title === 'call browser_action')
    expect(callEvent?.status).toBe('done')
    expect(callEvent?.detail).toContain('accepted')
    expect(callEvent?.detail).toContain(cards[0].id)
    expect(callEvent?.detail).toContain('部署方案对比') // echoed title

    // (3) the tool itself must NOT append an assistant message (§1.5)
    const messages = store.getter(activeMessagesAtom)
    const toolAuthored = messages.find(
      (m) => m.role === 'assistant' && m.content.includes('"accepted"'),
    )
    expect(toolAuthored).toBeUndefined()

    // (4) BF2: the FINAL assistant message summarizes the card key content (title
    //     + items), not merely "已渲染" — so info survives card loss (D2).
    const last = messages.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.content).toContain('部署方案对比')
    expect(last?.content).toContain('方案 A')
  })

  it('BF1 stale-run guard: a run superseded right before writing its card never writes it (no false accepted)', async () => {
    const store = createStore()

    // Hold the mock at "payload ready, not yet submitted" so we can supersede.
    let release: () => void = () => {}
    mockRenderCardControl.renderCardPayloadGate = new Promise<void>((resolve) => {
      release = resolve
    })

    startAgentRun(store, '渲染卡片 render card stale')

    // Wait until the first run has loaded the browser_action schema — it is now
    // parked on the gate, about to submit render_card.
    await waitFor(
      () => {
        const tools = store.getter(activeRunAtom)?.loadedTools ?? []
        expect(tools).toContain('browser_action')
      },
      { timeout: 8000 },
    )

    // Supersede the first run with a second run on the same session. This aborts
    // the first run's controller; once the gate releases, the OLD run proceeds
    // into runRuntimeTool and hits the stale guard (aborted / not current run).
    startAgentRun(store, 'hello')
    release()

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    // The stale run must NOT have written a card into ANY session bucket.
    expect(totalCards(store)).toBe(0)
    expect(store.getter(activeBrowserCardsAtom)).toHaveLength(0)
  })

  it('BF4 payload normalize: missing title -> error JSON, atom untouched, no throw', async () => {
    const store = createStore()
    startAgentRun(store, '渲染卡片 render card notitle')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    expect(totalCards(store)).toBe(0)
    const callEvent = store
      .getter(activeTimelineAtom)
      .find((event) => event.title === 'call browser_action')
    expect(callEvent?.detail).toContain('error')
  })

  it('BG1: on an error result (missing title) the mock final reply does NOT claim success', async () => {
    const store = createStore()
    startAgentRun(store, '渲染卡片 render card notitle')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    // no card written
    expect(totalCards(store)).toBe(0)
    // the final assistant message must NOT say "已渲染卡片" (false success) and
    // must surface the degraded "未渲染" wording instead.
    const last = store.getter(activeMessagesAtom).at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.content).not.toContain('已渲染卡片')
    expect(last?.content).toContain('未')
  })

  it('BG2: an unsupported action -> error JSON, no card, no throw, no false success', async () => {
    const store = createStore()
    startAgentRun(store, '渲染卡片 render card unknown action')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    expect(totalCards(store)).toBe(0)
    const callEvent = store
      .getter(activeTimelineAtom)
      .find((event) => event.title === 'call browser_action')
    expect(callEvent?.detail).toContain('error')
    expect(callEvent?.detail).toContain('Unsupported browser_action')
    const last = store.getter(activeMessagesAtom).at(-1)
    expect(last?.content).not.toContain('已渲染卡片')
  })
})

// BG3: assert directly (not via the 120-char timeline preview) that the success
// result echoes every card field back to the model.
describe('formatRenderCardResult (BG3)', () => {
  it('echoes title, body, items, options and the summarize note', () => {
    const json = formatRenderCardResult('card-xyz', {
      id: 'card-xyz',
      createdAt: 1,
      title: '部署方案对比',
      body: '**重点**：稳定性优先',
      items: ['方案 A', '方案 B'],
      options: ['选 A', '选 B'],
    })
    const parsed = JSON.parse(json)
    expect(parsed.accepted).toBe(true)
    expect(parsed.action).toBe('render_card')
    expect(parsed.cardId).toBe('card-xyz')
    expect(parsed.card).toEqual({
      title: '部署方案对比',
      body: '**重点**：稳定性优先',
      items: ['方案 A', '方案 B'],
      options: ['选 A', '选 B'],
    })
    expect(parsed.note).toContain('概括卡片要点')
  })
})

// BF4: direct unit coverage of normalize — unknown action is handled in the loop
// branch; here we cover title/body/items/options normalization rules.
describe('normalizeBrowserCardPayload (BF4)', () => {
  it('trims title, drops non-string body, filters empty/whitespace/non-string list entries', () => {
    const card = normalizeBrowserCardPayload({
      title: '  保留标题  ',
      body: 123,
      items: ['a', '', '  ', 'b', 5],
      options: [null, 'ok'],
    })
    expect(card).toBeDefined()
    expect(card!.title).toBe('保留标题')
    expect(card!.body).toBeUndefined()
    expect(card!.items).toEqual(['a', 'b'])
    expect(card!.options).toEqual(['ok'])
  })

  it('drops list fields entirely when nothing survives filtering', () => {
    const card = normalizeBrowserCardPayload({ title: 't', items: ['', '   '], options: [] })
    expect(card!.items).toBeUndefined()
    expect(card!.options).toBeUndefined()
  })

  it('returns undefined for missing or empty title', () => {
    expect(normalizeBrowserCardPayload({ body: 'x' })).toBeUndefined()
    expect(normalizeBrowserCardPayload({ title: '   ' })).toBeUndefined()
    expect(normalizeBrowserCardPayload(null)).toBeUndefined()
  })
})
