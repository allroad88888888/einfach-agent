import { useAtomValue, useSetAtom } from '@einfach/react'
import {
  useCallback,
  useLayoutEffect,
  useRef,
  type UIEvent,
} from 'react'
import {
  compensateScrollTop,
  demoMessagesAtom,
  messageWindowAtom,
  resetMessageWindowAtom,
  shiftMessageWindowAtom,
  visibleDemoMessagesAtom,
  type WindowDirection,
} from './windowScrollModel'
import './windowScrollDemo.css'

const EDGE_THRESHOLD_PX = 220

interface PendingAnchor {
  key: string
  top: number
}

function firstVisibleAnchor(container: HTMLDivElement): PendingAnchor | undefined {
  const containerTop = container.getBoundingClientRect().top
  const rows = container.querySelectorAll<HTMLElement>('[data-window-row]')
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > containerTop + 1) {
      const key = row.dataset.windowRow
      if (key) return { key, top: rect.top }
    }
  }
  return undefined
}

export function WindowScrollDemo() {
  const allMessages = useAtomValue(demoMessagesAtom)
  const visibleMessages = useAtomValue(visibleDemoMessagesAtom)
  const window = useAtomValue(messageWindowAtom)
  const shiftWindow = useSetAtom(shiftMessageWindowAtom)
  const resetWindow = useSetAtom(resetMessageWindowAtom)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pendingAnchorRef = useRef<PendingAnchor | undefined>(undefined)
  const shiftingRef = useRef(false)
  const pendingResetRef = useRef<'center' | 'latest' | undefined>('center')

  const move = useCallback((direction: Exclude<WindowDirection, 'idle'>) => {
    const scroller = scrollerRef.current
    if (!scroller || shiftingRef.current) return
    if (direction === 'backward' && window.start === 0) return
    if (direction === 'forward' && window.end === allMessages.length) return

    const anchor = firstVisibleAnchor(scroller)
    if (!anchor) return
    pendingAnchorRef.current = anchor
    shiftingRef.current = true
    shiftWindow(direction)
  }, [allMessages.length, shiftWindow, window.end, window.start])

  const reset = useCallback((target: 'center' | 'latest') => {
    pendingAnchorRef.current = undefined
    shiftingRef.current = true
    pendingResetRef.current = target
    resetWindow(target)
  }, [resetWindow])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const resetTarget = pendingResetRef.current
    if (resetTarget) {
      scroller.scrollTop = resetTarget === 'latest'
        ? scroller.scrollHeight
        : Math.max(0, (scroller.scrollHeight - scroller.clientHeight) / 2)
      pendingResetRef.current = undefined
      shiftingRef.current = false
      return
    }

    const anchor = pendingAnchorRef.current
    if (!anchor) {
      shiftingRef.current = false
      return
    }

    const nextAnchor = scroller.querySelector<HTMLElement>(
      `[data-window-row="${anchor.key}"]`,
    )
    if (nextAnchor) {
      scroller.scrollTop = compensateScrollTop(
        scroller.scrollTop,
        anchor.top,
        nextAnchor.getBoundingClientRect().top,
      )
    }
    pendingAnchorRef.current = undefined

    const frame = requestAnimationFrame(() => {
      shiftingRef.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [window.end, window.start])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (shiftingRef.current) return
    const node = event.currentTarget
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    if (node.scrollTop <= EDGE_THRESHOLD_PX) {
      move('backward')
    } else if (distanceToBottom <= EDGE_THRESHOLD_PX) {
      move('forward')
    }
  }

  return (
    <main className="window-demo-shell">
      <header className="window-demo-header">
        <div>
          <span className="window-demo-eyebrow">实验页面</span>
          <h1>双向滑动窗口</h1>
          <p>
            只有当前窗口进入 DOM。滚到上下边缘时移动 atom 窗口，并用同一条消息补偿滚动位置。
          </p>
        </div>
        <a className="window-demo-back" href="/">返回主界面</a>
      </header>

      <section className="window-demo-toolbar" aria-label="窗口状态">
        <div className="window-demo-stat">
          <span>Atom 窗口</span>
          <strong>{window.start + 1}–{window.end}</strong>
        </div>
        <div className="window-demo-stat">
          <span>DOM 节点</span>
          <strong>{visibleMessages.length} / {allMessages.length}</strong>
        </div>
        <div className="window-demo-stat">
          <span>换窗次数</span>
          <strong>{window.shifts}</strong>
        </div>
        <div className="window-demo-stat">
          <span>最近方向</span>
          <strong>
            {window.direction === 'forward'
              ? '向下'
              : window.direction === 'backward'
                ? '向上'
                : '—'}
          </strong>
        </div>
        <div className="window-demo-actions">
          <button type="button" onClick={() => move('backward')}>向前一窗</button>
          <button type="button" onClick={() => move('forward')}>向后一窗</button>
          <button type="button" onClick={() => reset('center')}>回到中段</button>
          <button type="button" onClick={() => reset('latest')}>跳到最新</button>
        </div>
      </section>

      <section className="window-demo-stage">
        <div className="window-demo-hint window-demo-hint--top">
          接近顶部会向前换窗，滚动条向下回退
        </div>
        <div
          ref={scrollerRef}
          className="window-demo-scroller"
          data-testid="window-demo-scroller"
          onScroll={handleScroll}
        >
          <div className="window-demo-feed">
            {visibleMessages.map((message) => (
              <article
                key={message.id}
                className={`window-demo-row window-demo-row--${message.role}`}
                data-window-row={message.id}
              >
                <div className="window-demo-avatar">
                  {message.role === 'user' ? '你' : 'AI'}
                </div>
                <div className="window-demo-bubble">
                  <div className="window-demo-row-meta">
                    <strong>{message.title}</strong>
                    <span>全量索引 {message.index}</span>
                  </div>
                  {message.body.split('\n\n').map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className="window-demo-hint window-demo-hint--bottom">
          接近底部会向后换窗，滚动条向上回退
        </div>
      </section>

      <footer className="window-demo-footer">
        当前页面没有总高度占位、绝对定位和全量行高缓存。滚动条只代表这 {visibleMessages.length} 条消息。
      </footer>
    </main>
  )
}
