import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { resetRootStore } from '@web-agent/core/state/rootStore'
// 【setupFile 纪律】本文件是 vitest setupFile，在每个测试文件的 vi.mock 提升之前执行。
// 这里**不能**改走根 barrel `@web-agent/core`：barrel 会把 runtime/commands 整条静态导链
// 提前灌进模块缓存，导致测试里 vi.mock('@web-agent/core/runtime/commands') 拿到的是缓存的
// 真实实现（表现为「not a spy」）。故 defaultCore 保持深路径。
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { registerStandardTools } from '@web-agent/tools'

// 【登记反转 · TS1】defaultCore 造出来无工具（core 不再硬编码标准工具）。测试大量断言 defaultCore/
// toolRegistry 已带 21 个标准工具——在此（每个测试文件加载前跑一次，register 幂等）统一注册进
// defaultCore.tools（= toolRegistry），把"文件级 churn"收敛成这一行。仅【新建 fresh core】的用例
// 需各自 createCoreInstance({ registerTools: registerStandardTools }) 显式装。
registerStandardTools(toolRegistry)
// 不要在 setup 里 import projectSkillsBridge / workspaceRead：那会在各测试文件的 vi.mock 生效前
// 把真 @tauri-apps/api 灌进 worker 模块图，导致 Tauri mock 全部失效（B1 后的回归教训）。
// jsdom 下 buildProjectSkillsProvider() 恒为 undefined，测试语义靠调用点 fallback，无需在此装配。

Element.prototype.scrollIntoView = vi.fn()
window.scrollTo = vi.fn()

beforeEach(() => {
  vi.stubEnv('VITE_AGENT_MODEL_PROVIDER', 'mock')
})

afterEach(() => {
  cleanup()
  // Vitest isolates every test file in its own worker. These default-core stores only need
  // cleanup between cases inside that worker; they are never used to serialize test files.
  defaultCore.resetSessionStores()
  resetRootStore()
  vi.unstubAllEnvs()
})
