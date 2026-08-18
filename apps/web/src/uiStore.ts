// 整个界面的 store —— 一个，全局唯一。
// ---------------------------------------------------------------------------
// 这里装的是**渲染态**：设置面板、MCP、插件、trace viewer、工作区重命名草稿、消息滑动窗口、
// 思考组与计划的展开折叠、输入框草稿与图片附件。判据是「刷新丢了也没人发现」。
//
// 拆分前它们没有家：`main.tsx` 把 `core.rootStore` 当环境 store，于是 mcp/settings/plugins 那几十个
// atom 物理上住在 core 的跨会话登记表里；右栏又被 `ActiveSessionProvider` 切到会话 store，于是
// 消息窗口、草稿、图片附件住在**会话** store 里。两处都是「渲染层随手 useAtom，值落在 core 的
// 某个 store 上」——治理边界因此只能靠手工表维持。
//
// 现在界面自己持有一个 store，core 的两个 store 经 `@web-agent/react-plugin` 的
// `useRootAtomValue` / `useAgentAtomValue` 读。**不按会话分桶**：界面就是一个，
// 少数需要跟着会话清空的槽位见 `agentNew/ui/sessionScopedViewState.ts`。

import { createStore } from '@einfach/core'

export const uiStore = createStore()
