// 可恢复 child 任务的唯一 session-scoped 状态源。

import { atom } from '@einfach/core'
import type { SubagentContinuationV1 } from './recoverySnapshot.type'

/** 值由每个 session store 隔离；恢复快照只投影这里，绝不另建 continuation 容器。 */
export const subagentContinuationsAtom = atom<SubagentContinuationV1[]>([])
