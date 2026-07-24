import { atom } from '@einfach/core'

export type MessageWindowDirection = 'idle' | 'backward' | 'forward'

export interface MessageWindow {
  start: number
  end: number
  direction: MessageWindowDirection
}

export const MESSAGE_WINDOW_SIZE = 80
export const MESSAGE_WINDOW_STEP = 24

export const EMPTY_MESSAGE_WINDOW: MessageWindow = {
  start: 0,
  end: 0,
  direction: 'idle',
}

export const messageWindowAtom = atom<MessageWindow>(EMPTY_MESSAGE_WINDOW)
export const planTraceWindowsAtom = atom<Record<string, MessageWindow>>({})

export function latestMessageWindow(total: number): MessageWindow {
  return {
    start: Math.max(0, total - MESSAGE_WINDOW_SIZE),
    end: total,
    direction: 'idle',
  }
}

export function resolveMessageWindow(
  current: MessageWindow,
  total: number,
  stickToLatest: boolean,
): MessageWindow {
  if (total <= 0) return { start: 0, end: 0, direction: current.direction }
  if (stickToLatest || current.end === 0) {
    return { ...latestMessageWindow(total), direction: current.direction }
  }

  const size = Math.min(MESSAGE_WINDOW_SIZE, total)
  const start = Math.min(
    Math.max(0, current.start),
    Math.max(0, total - size),
  )
  return {
    start,
    end: Math.min(total, start + size),
    direction: current.direction,
  }
}

export function moveMessageWindow(
  current: MessageWindow,
  direction: Exclude<MessageWindowDirection, 'idle'>,
  total: number,
): MessageWindow {
  const resolved = resolveMessageWindow(current, total, false)
  if (direction === 'backward') {
    if (resolved.start === 0) return resolved
    const start = Math.max(0, resolved.start - MESSAGE_WINDOW_STEP)
    return {
      start,
      end: Math.min(total, start + Math.min(MESSAGE_WINDOW_SIZE, total)),
      direction,
    }
  }

  if (resolved.end >= total) return resolved
  const end = Math.min(total, resolved.end + MESSAGE_WINDOW_STEP)
  return {
    start: Math.max(0, end - Math.min(MESSAGE_WINDOW_SIZE, total)),
    end,
    direction,
  }
}

export function compensateMessageScrollTop(
  scrollTop: number,
  anchorTopBefore: number,
  anchorTopAfter: number,
): number {
  return Math.max(0, scrollTop + anchorTopAfter - anchorTopBefore)
}
