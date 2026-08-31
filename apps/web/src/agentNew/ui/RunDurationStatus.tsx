// 当前运行回合的耗时状态。

import { useAtom } from '@einfach/react'
import { useEffect } from 'react'
import type { ConversationItem, RunState } from '@einfach-agent/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { messageElapsedClockAtom } from './messageWindowModel'

function elapsedDurationParts(durationMs: number): readonly [number, number, number] {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
}

function runStartIndex(items: ConversationItem[], turnId?: string): number {
  if (turnId) {
    const anchored = items.findIndex((item) => item.id === turnId)
    if (anchored >= 0) return anchored
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') return index
  }
  return -1
}

export function RunDurationStatus({ items, run }: { items: ConversationItem[]; run?: RunState }) {
  const { t } = useLingui()
  const [clock, setClock] = useAtom(messageElapsedClockAtom)
  const working = run?.status === 'running' || run?.status === 'awaiting_tool'
  useEffect(() => {
    if (!working) return
    const updateClock = () => setClock(Date.now())
    updateClock()
    const timer = window.setInterval(updateClock, 1_000)
    return () => window.clearInterval(timer)
  }, [run?.runId, setClock, working])
  if (!run || (!working && run.status !== 'done')) return null
  const startIndex = runStartIndex(items, run.turnId)
  if (startIndex < 0) return null
  const startedAt = run.startedAt ?? items[startIndex].createdAt
  let endedAt = startedAt
  for (let index = startIndex; index < items.length; index += 1) endedAt = Math.max(endedAt, items[index].createdAt)
  endedAt = run.finishedAt ?? endedAt
  const durationMs = Math.max(0, (working ? clock : endedAt) - startedAt)
  const [hours, minutes, seconds] = elapsedDurationParts(durationMs)
  const duration = hours > 0
    ? t`${hours}h ${minutes}m ${seconds}s`
    : minutes > 0 ? t`${minutes}m ${seconds}s` : t`${seconds}s`
  const label = working ? t`Working` : t`Brewed`
  return (
    <div
      className={`agentnew-run-duration${working ? ' is-working' : ' is-complete'}`}
      aria-label={working ? t`对话正在进行，已用时 ${duration}` : t`对话已结束，用时 ${duration}`}
    >
      <span className="agentnew-run-duration-mark" aria-hidden="true">{working ? null : '✓'}</span>
      <span>
        <Trans><strong>{label}</strong> for <time dateTime={`PT${Math.floor(durationMs / 1_000)}S`}>{duration}</time></Trans>
      </span>
    </div>
  )
}
