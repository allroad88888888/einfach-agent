import { render, waitFor, act } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mock echarts BEFORE importing anything that pulls @ai-components/markdown ---
// EChartsCodeBlock (in @ai-components/code, pulled in via vite alias) does
// `import * as echarts from 'echarts'`; the Vitest-only alias (vite.config
// test.alias) maps that bare specifier to the app's node_modules so this
// module mock reliably intercepts it (build/dev resolution is untouched).
type ChartInstance = {
  setOption: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

// `vi.mock` is hoisted above module-top declarations, so the shared mock state
// must live in `vi.hoisted` to be referenceable from the (also hoisted) factory.
const { created, initMock } = vi.hoisted(() => {
  const created: ChartInstance[] = []
  const initMock = vi.fn(() => {
    const inst: ChartInstance = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    }
    created.push(inst)
    return inst
  })
  return { created, initMock }
})

vi.mock('echarts', () => ({
  init: initMock,
}))

// Import after vi.mock so the aliased ai-components source picks up the mock.
import { Markdown } from '@ai-components/markdown'

const ECHARTS_OPTION = `{ "xAxis": { "type": "category", "data": ["a", "b"] }, "yAxis": { "type": "value" }, "series": [{ "type": "bar", "data": [1, 2] }] }`

function echartsMarkdown(option = ECHARTS_OPTION) {
  return ['```echarts', option, '```'].join('\n')
}

let unhandled: unknown[] = []
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason)
}

beforeEach(() => {
  created.length = 0
  initMock.mockClear()
  unhandled = []
  window.addEventListener('unhandledrejection', onUnhandled)
})

afterEach(() => {
  window.removeEventListener('unhandledrejection', onUnhandled)
  vi.restoreAllMocks()
})

describe('Markdown ```echarts block → EChartsCodeBlock lifecycle', () => {
  it('initializes the chart and pushes the option (init + setOption + resize)', async () => {
    render(<Markdown>{echartsMarkdown()}</Markdown>)

    await waitFor(() => expect(initMock).toHaveBeenCalled())

    const inst = created[0]
    expect(inst).toBeTruthy()
    await waitFor(() => expect(inst.setOption).toHaveBeenCalled())
    expect(inst.resize).toHaveBeenCalled()
    // setOption receives the parsed option (merge=true second arg)
    const [optionArg] = inst.setOption.mock.calls[0]
    expect(optionArg).toMatchObject({ series: expect.any(Array) })
    expect(unhandled).toHaveLength(0)
  })

  it('disposes the chart instance on unmount (no leak)', async () => {
    const { unmount } = render(<Markdown>{echartsMarkdown()}</Markdown>)
    await waitFor(() => expect(initMock).toHaveBeenCalled())
    const inst = created[0]

    unmount()
    expect(inst.dispose).toHaveBeenCalled()
    expect(unhandled).toHaveLength(0)
  })

  it('under StrictMode double-mount, every created instance is eventually disposed (no leak)', async () => {
    const { unmount } = render(
      <StrictMode>
        <Markdown>{echartsMarkdown()}</Markdown>
      </StrictMode>,
    )

    await waitFor(() => expect(initMock).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    unmount()

    // Don't assert a fixed call count (StrictMode double-invokes). Instead assert
    // the invariant: no live instance leaks — each created chart is disposed.
    await waitFor(() => {
      for (const inst of created) {
        expect(inst.dispose).toHaveBeenCalled()
      }
    })
    expect(unhandled).toHaveLength(0)
  })

  it('does not throw / no unhandled rejection on an unparseable echarts option (parse-error contract)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // not valid JS object literal — `new Function('return ...')` will throw and be caught
    const bad = ['```echarts', '{ this is not valid }', '```'].join('\n')

    const { container } = render(<Markdown>{bad}</Markdown>)

    // parse error is handled internally → error placeholder, init never runs
    await waitFor(() => {
      expect(container.querySelector('.ai-echarts-error')).toBeTruthy()
    })
    expect(initMock).not.toHaveBeenCalled()
    expect(unhandled).toHaveLength(0)
    consoleError.mockRestore()
  })
})

describe('Markdown fenced code block → syntax highlight (prismjs)', () => {
  it('injects highlight token DOM for a known language', async () => {
    const md = ['```typescript', 'const answer: number = 42', '```'].join('\n')
    const { container } = render(<Markdown>{md}</Markdown>)

    const code = container.querySelector('code.language-typescript')
    expect(code).toBeTruthy()

    await waitFor(() => {
      expect(container.querySelector('.token')).toBeTruthy()
    })
    expect(unhandled).toHaveLength(0)
  })

  it('falls back without crashing for an unknown language (no grammar)', async () => {
    const md = ['```wat-no-such-lang', 'some raw text here', '```'].join('\n')
    const { container } = render(<Markdown>{md}</Markdown>)

    // CodeBlock still renders the content in a language-* code element, just no tokens
    const code = container.querySelector('code.language-wat-no-such-lang')
    expect(code).toBeTruthy()
    expect(code?.textContent).toContain('some raw text here')
    // fallback really is *not* highlighted (no prism tokens for unknown grammar)
    expect(code?.querySelector('.token')).toBeNull()
    expect(unhandled).toHaveLength(0)
  })
})
