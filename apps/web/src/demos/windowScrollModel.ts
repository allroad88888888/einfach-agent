import { atom } from '@einfach/core'

export type WindowDirection = 'idle' | 'backward' | 'forward'

export interface DemoMessage {
  id: string
  index: number
  role: 'user' | 'assistant'
  title: string
  body: string
}

export interface MessageWindow {
  start: number
  end: number
  shifts: number
  direction: WindowDirection
}

export const DEMO_MESSAGE_COUNT = 500
export const DEMO_WINDOW_SIZE = 56
export const DEMO_WINDOW_STEP = 16

const paragraphFragments = [
  '这一条故意很短，用来观察窗口换页时不同高度内容是否仍然稳定。',
  '可变高度列表最容易在移除顶部节点时发生视觉跳动。这里不保存全量尺寸，只比较同一个锚点在 DOM 更新前后的屏幕坐标。',
  '窗口中的消息保持正常文档流。接近边缘时，atom 只移动 start 和 end；React 卸载窗口外节点，再挂载下一批节点。',
  '如果补偿正确，你会看到滚动条滑块退回一点，但正在阅读的内容不会突然跳走，还可以沿原方向继续滚动。',
]

function makeBody(index: number): string {
  const paragraphCount = (index % paragraphFragments.length) + 1
  return Array.from({ length: paragraphCount }, (_, paragraphIndex) => (
    paragraphFragments[(index + paragraphIndex) % paragraphFragments.length]
  )).join('\n\n')
}

export const demoMessagesAtom = atom<DemoMessage[]>(
  Array.from({ length: DEMO_MESSAGE_COUNT }, (_, index): DemoMessage => ({
    id: `demo-message-${index}`,
    index,
    role: index % 4 === 0 ? 'user' : 'assistant',
    title: `消息 ${index + 1}`,
    body: makeBody(index),
  })),
)

export function centeredWindow(total: number): MessageWindow {
  const start = Math.max(0, Math.floor((total - DEMO_WINDOW_SIZE) / 2))
  return {
    start,
    end: Math.min(total, start + DEMO_WINDOW_SIZE),
    shifts: 0,
    direction: 'idle',
  }
}

export function latestWindow(total: number): MessageWindow {
  return {
    start: Math.max(0, total - DEMO_WINDOW_SIZE),
    end: total,
    shifts: 0,
    direction: 'idle',
  }
}

export function moveWindow(
  current: MessageWindow,
  direction: Exclude<WindowDirection, 'idle'>,
  total: number,
): MessageWindow {
  if (direction === 'forward') {
    if (current.end >= total) return current
    const end = Math.min(total, current.end + DEMO_WINDOW_STEP)
    const start = Math.max(0, end - DEMO_WINDOW_SIZE)
    return {
      start,
      end,
      shifts: current.shifts + 1,
      direction,
    }
  }

  if (current.start <= 0) return current
  const start = Math.max(0, current.start - DEMO_WINDOW_STEP)
  const end = Math.min(total, start + DEMO_WINDOW_SIZE)
  return {
    start,
    end,
    shifts: current.shifts + 1,
    direction,
  }
}

export const messageWindowAtom = atom<MessageWindow>(centeredWindow(DEMO_MESSAGE_COUNT))

export const visibleDemoMessagesAtom = atom((get) => {
  const messages = get(demoMessagesAtom)
  const window = get(messageWindowAtom)
  return messages.slice(window.start, window.end)
})

export const shiftMessageWindowAtom = atom(
  null,
  (get, set, direction: Exclude<WindowDirection, 'idle'>) => {
    const total = get(demoMessagesAtom).length
    set(messageWindowAtom, moveWindow(get(messageWindowAtom), direction, total))
  },
)

export const resetMessageWindowAtom = atom(
  null,
  (get, set, target: 'center' | 'latest') => {
    const total = get(demoMessagesAtom).length
    set(
      messageWindowAtom,
      target === 'latest' ? latestWindow(total) : centeredWindow(total),
    )
  },
)

export function compensateScrollTop(
  scrollTop: number,
  anchorTopBefore: number,
  anchorTopAfter: number,
): number {
  return Math.max(0, scrollTop + anchorTopAfter - anchorTopBefore)
}
