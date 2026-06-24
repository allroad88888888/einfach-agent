import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

Element.prototype.scrollIntoView = vi.fn()
window.scrollTo = vi.fn()

beforeEach(() => {
  vi.stubEnv('VITE_AGENT_MODEL_PROVIDER', 'mock')
  vi.stubEnv('VITE_DEEPSEEK_API_KEY', '')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})
