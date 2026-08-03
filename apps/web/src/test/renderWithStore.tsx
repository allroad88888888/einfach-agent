import type { ReactElement } from 'react'
import { Provider } from '@einfach/react'
import { createStore, type Store } from '@einfach/core'
import { render, type RenderOptions } from '@testing-library/react'
import { WebTimelineRendererRegistryProvider } from '../agentNew/ui/WebTimelineRendererRegistryProvider'

export function renderWithStore(
  ui: ReactElement,
  options: RenderOptions & { store?: Store } = {},
) {
  const store = options.store ?? createStore()
  const { store: _store, ...renderOptions } = options

  return {
    store,
    ...render(
      <Provider store={store}>
        <WebTimelineRendererRegistryProvider>{ui}</WebTimelineRendererRegistryProvider>
      </Provider>,
      renderOptions,
    ),
  }
}
