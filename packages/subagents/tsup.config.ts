// @web-agent/subagents 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 两条公开 subpath：根 barrel 与 `./archive/replay`（后者是 scripts/subagent-replay-lib.test.js
  // 的权威事件类型来源，见该文件顶部注释）。对象形态的 key 就是 dist 产物路径，与 package.json
  // 的 exports 逐条对应。
  entry: {
    index: 'src/index.ts',
    'archive/replay': 'src/archive/replay.ts',
  },
  // 两条 entry 共享 archive/replay.ts 及其闭包（jsonl.ts、replayEventSchema.ts、
  // replayNodeState.ts——index.ts 用 `export * from './archive/replay'` 把它们并入根 barrel）。
  // 实测（构建后 grep 两份 dist 产物）：这条共享闭包全是纯函数/纯类型，零模块级可变单例
  // （无 let/var 顶层声明、无 new Map()/WeakMap 缓存），不存在「两份互不可见的状态」风险，
  // 故不用开 splitting。真正持有单例的 state/subagentViewAtoms 等文件只被 index.ts 一侧引用，
  // 不进 archive/replay 这条 entry，天然没有交集。证据见 V3b 验收报告。
  splitting: false,
  // @einfach/core、@web-agent/ai、@web-agent/core 都在本包 dependencies，tsup 自动 external。
  external: [],
})
