// 待保存产物槽位的增量记账 —— 把通用列表机制绑到 pendingArtifacts 上。
// ---------------------------------------------------------------------------
// 机制与理由在 listSlotLog.ts；本文件只负责「pendingArtifacts 这个槽位怎么用它」。
//
// 为什么它也需要增量：`PendingArtifact.content` 是**完整文件正文**（`save_file` 只回 id 与字节数，
// 正文的唯一副本就在这个 atom 里，见 sessionSlots.ts 的判据），而排空只发生在用户点了产物卡片时
// （唯一调用点是 runtime/commands/cardCommands.ts）。用户不理那些卡片，列表就在整个会话期间累积，
// 于是整值记账下每 add 一次都要把「已攒下的全部文件正文」存进日志两遍。
//
// 用到 append 与 remove，没有 patch：产物一旦暂存就不再被修改，只会被整条移除。

import type { PendingArtifact } from './sessionTransientPayloads'
import { pendingArtifactsAtom } from './sessionTransientAtoms'
import { createListSlotLog } from './listSlotLog'
import type { SlotWriteTarget } from './sessionSlotWrite'

const artifactsLog = createListSlotLog<PendingArtifact>({
  key: 'pendingArtifacts',
  atom: pendingArtifactsAtom,
  idOf: (artifact) => artifact.id,
})

/** 把 pendingArtifacts 的增量还原方式登记进一本日志。由槽位表在建日志时调用。 */
export const registerPendingArtifactsAppliers = artifactsLog.register

/** 暂存一个产物并只记这一条的账。 */
export function appendPendingArtifactLogged(
  target: SlotWriteTarget,
  artifact: PendingArtifact,
): void {
  artifactsLog.append(target, artifact)
}

/** 移除一个产物并只记这一条的账（逆操作按原下标插回）。找不到该 id 时整体 no-op。 */
export function removePendingArtifactLogged(target: SlotWriteTarget, artifactId: string): void {
  artifactsLog.remove(target, artifactId)
}
