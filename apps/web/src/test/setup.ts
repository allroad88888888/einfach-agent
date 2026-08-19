import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetRootStore } from '@einfach-agent/core/state/rootStore'
// 【setupFile 纪律】本文件是 vitest setupFile，在每个测试文件的 vi.mock 提升之前执行。
// 这里**不能**改走根 barrel `@einfach-agent/core`：barrel 会把 runtime/commands 整条静态导链
// 提前灌进模块缓存，导致测试里 vi.mock('@einfach-agent/core/runtime/commands') 拿到的是缓存的
// 真实实现（表现为「not a spy」）。故 defaultCore 保持深路径。
import { defaultCore } from '@einfach-agent/core/runtime/core/coreInstance'
import { registerStandardTools } from '@einfach-agent/tools'

// 【登记反转 · TS1】defaultCore 造出来无工具（core 不再硬编码标准工具）。测试大量断言
// defaultCore.tools 已带 21 个标准工具——在此（每个测试文件加载前跑一次，register 幂等）统一注册进
// defaultCore.tools，把"文件级 churn"收敛成这一行。仅【新建 fresh core】的用例
// 需各自 createCoreInstance({ registerTools: registerStandardTools }) 显式装。
registerStandardTools(defaultCore.tools)
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
  // 界面 store **刻意不在这里整体 clear**：拆分前那些 atom 就住在 rootStore 里，而
  // resetRootStore() 只推回它自己那张表，从不动应用层 atom。整体 clear 会改掉既有用例的
  // 隔离语义（设置/MCP/插件用例靠模块级 service 在同文件内跨用例复用装配），
  // 那是另一件事，不该由一次 store 拆分顺手改掉。各测试文件仍用自己的 reset*State(uiStore)。
  resetRootStore()
  vi.unstubAllEnvs()
})
