import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { itemsAtom } from '@einfach-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { HistoryImageCompatibilityProvider } from './HistoryImageCompatibilityContext'
import { HistoryImageCompatibilityGuard } from './HistoryImageCompatibilityGuard'

function storeWithImage() {
  const store = createStore()
  store.setter(itemsAtom, [{
    id: 'user-one',
    createdAt: 1,
    item: {
      role: 'user',
      content: [{
        type: 'image',
        source: {
          kind: 'provider-file',
          provider: 'kimi',
          scope: 'kimi:cn',
          reference: 'ms://private-file-id',
        },
        name: 'private.png',
        mimeType: 'image/png',
        byteSize: 10,
      }],
    },
  }])
  return store
}

describe('history image compatibility guard', () => {
  it('blocks the composer surface with an explicit warning for incompatible history', () => {
    const { container } = renderWithStore(
      <HistoryImageCompatibilityProvider vendor="glm" model="glm-4.7">
        <HistoryImageCompatibilityGuard>
          <button type="button">发送</button>
        </HistoryImageCompatibilityGuard>
      </HistoryImageCompatibilityProvider>,
      { agentStore: storeWithImage() },
    )

    expect(screen.getByRole('alert')).toHaveTextContent('当前模型无法继续使用对话中的 1 张历史图片')
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.getByRole('textbox', { name: '历史图片不兼容，输入已禁用' })).toBeDisabled()
    expect(container).not.toHaveTextContent('private-file-id')
    expect(container).not.toHaveTextContent('kimi:cn')
  })

  it('renders the normal composer surface for matching Kimi history', () => {
    renderWithStore(
      <HistoryImageCompatibilityProvider vendor="kimi" model="kimi-k2.6" region="cn">
        <HistoryImageCompatibilityGuard>
          <button type="button">发送</button>
        </HistoryImageCompatibilityGuard>
      </HistoryImageCompatibilityProvider>,
      { agentStore: storeWithImage() },
    )

    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
