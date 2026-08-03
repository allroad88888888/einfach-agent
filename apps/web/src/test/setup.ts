import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { resetRootStore } from '@web-agent/core/state/rootStore'
import { resetSessionStores } from '@web-agent/core/state/sessionStore'
import { registerStandardTools } from '@web-agent/tools'

// 【登记反转 · TS1】defaultCore 造出来无工具（core 不再硬编码标准工具）。测试大量断言 defaultCore/
// toolRegistry 已带 21 个标准工具——在此（每个测试文件加载前跑一次，register 幂等）统一注册进
// defaultCore.tools（= toolRegistry），把"文件级 churn"收敛成这一行。仅【新建 fresh core】的用例
// 需各自 createCoreInstance({ registerTools: registerStandardTools }) 显式装。
registerStandardTools(toolRegistry)

Element.prototype.scrollIntoView = vi.fn()
window.scrollTo = vi.fn()

beforeEach(() => {
  vi.stubEnv('VITE_AGENT_MODEL_PROVIDER', 'mock')
  vi.stubEnv('VITE_DEEPSEEK_API_KEY', '')
})

afterEach(() => {
  cleanup()
  // Vitest isolates every test file in its own worker. These default-core stores only need
  // cleanup between cases inside that worker; they are never used to serialize test files.
  resetSessionStores()
  resetRootStore()
  vi.unstubAllEnvs()
})
