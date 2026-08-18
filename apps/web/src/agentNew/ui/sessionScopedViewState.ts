// 界面 store 里少数「属于当前会话」的渲染态，以及切会话时把它们推回默认值。
// ---------------------------------------------------------------------------
// 界面只有一个 store，不按会话分桶。绝大多数渲染态无所谓：设置面板、展开折叠偏好本来就是
// 全局的；`expandedTranscriptGroups` / `expandedPlanStages` 按 group/stage id 索引，换会话
// 自然查不到旧 key；`messageWindow` 会被 `resolveMessageWindow` 按总条数夹回去。
//
// 但下面这几个装着**用户当前正在输入的东西**，跟着会话走不掉：不清的话，在会话 A 打了一半的字
// 和挂上的图片会跟着你切到会话 B，点发送就发到错的会话里去了。所以这里显式列出来、显式清。
//
// 为什么不做成按 sessionId 分桶的 atom family：那等于把「每会话一个 store」换个写法再做一遍，
// 而这几项的语义本来就是「切走即作废」，不是「切回来要还在」——草稿刷新即丢是明确裁决。

import type { Store } from '@einfach/core'
import { composerDraftAtom } from './composerDraftState'
import { composerImageAttachmentAtom } from './composerImageAttachmentState'
import { EMPTY_MESSAGE_WINDOW, messageWindowAtom, planTraceWindowsAtom } from './messageWindowModel'

/** 切会话时把「当前正在输入 / 正在看的位置」推回默认值。 */
export function resetSessionScopedViewState(store: Store): void {
  store.setter(composerDraftAtom, '')
  // 不复用 clearComposerImageAttachmentsAtom：那条在 operation !== 'idle' 时**拒绝清空**
  // （防止清掉正在准备中的一批），而切会话必须无条件清。`revision` 照旧 +1，
  // 好让还在飞的那次准备/提交在 settle 时按版本号被丢弃，而不是回填到新会话的输入框里。
  store.setter(composerImageAttachmentAtom, (prev) => ({
    images: [], operation: 'idle', revision: prev.revision + 1,
  }))
  store.setter(messageWindowAtom, EMPTY_MESSAGE_WINDOW)
  store.setter(planTraceWindowsAtom, {})
}
