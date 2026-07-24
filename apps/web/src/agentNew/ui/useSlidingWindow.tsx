import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
import {
  compensateMessageScrollTop,
  moveMessageWindow,
  resolveMessageWindow,
  type MessageWindow,
  type MessageWindowDirection,
} from './messageWindowModel'

const BOTTOM_STICKY_THRESHOLD = 48
const WINDOW_EDGE_THRESHOLD = 220

interface ScrollAnchor {
  key: string
  top: number
}

function firstVisibleAnchor(node: HTMLDivElement): ScrollAnchor | undefined {
  const rows = Array.from(
    node.querySelectorAll<HTMLElement>('[data-window-key]'),
  )
  if (rows.length === 0) return undefined
  const containerTop = node.getBoundingClientRect().top
  const visible = rows.find((row) => row.getBoundingClientRect().bottom > containerTop + 1)
  const anchor = visible ?? rows[0]
  return {
    key: anchor.dataset.windowKey ?? '',
    top: anchor.getBoundingClientRect().top,
  }
}

function findWindowRow(node: HTMLDivElement, key: string): HTMLElement | undefined {
  return Array.from(
    node.querySelectorAll<HTMLElement>('[data-window-key]'),
  ).find((row) => row.dataset.windowKey === key)
}

function borderBlockSize(entry: ResizeObserverEntry): number {
  const borderSize = entry.borderBoxSize as
    | readonly ResizeObserverSize[]
    | ResizeObserverSize
  if (Array.isArray(borderSize)) {
    return borderSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height
  }
  return (borderSize as ResizeObserverSize | undefined)?.blockSize
    ?? entry.target.getBoundingClientRect().height
}

export function SlidingWindowRow({
  rowKey,
  register,
  className = 'agentnew-window-row',
  children,
}: {
  rowKey: string
  register: (key: string, node: HTMLDivElement) => () => void
  className?: string
  children: ReactNode
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const node = rowRef.current
    if (!node) return
    return register(rowKey, node)
  }, [register, rowKey])
  return (
    <div
      ref={rowRef}
      className={className}
      data-window-key={rowKey}
    >
      {children}
    </div>
  )
}

export function useSlidingWindow({
  total,
  storedWindow,
  setStoredWindow,
  latestVersion,
}: {
  total: number
  storedWindow: MessageWindow
  setStoredWindow: (next: MessageWindow) => void
  latestVersion?: string
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const shiftingWindowRef = useRef(false)
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null)
  const measuredSizesRef = useRef(new Map<string, number>())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const unlockFrameRef = useRef<number | null>(null)

  const resolvedWindow = resolveMessageWindow(
    storedWindow,
    total,
    shouldStickToBottomRef.current,
  )

  const unlockWindowShift = useCallback(() => {
    if (unlockFrameRef.current != null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(unlockFrameRef.current)
      } else {
        window.clearTimeout(unlockFrameRef.current)
      }
    }
    const unlock = () => {
      unlockFrameRef.current = null
      shiftingWindowRef.current = false
    }
    unlockFrameRef.current = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(unlock)
      : window.setTimeout(unlock, 0)
  }, [])

  const shiftWindow = useCallback((
    direction: Exclude<MessageWindowDirection, 'idle'>,
  ) => {
    const node = scrollRef.current
    if (!node || shiftingWindowRef.current) return
    const nextWindow = moveMessageWindow(resolvedWindow, direction, total)
    if (
      nextWindow.start === resolvedWindow.start &&
      nextWindow.end === resolvedWindow.end
    ) return

    pendingAnchorRef.current = firstVisibleAnchor(node) ?? null
    shiftingWindowRef.current = true
    setStoredWindow(nextWindow)
  }, [resolvedWindow, setStoredWindow, total])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return

    const handleScroll = () => {
      if (shiftingWindowRef.current) return
      const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      shouldStickToBottomRef.current = (
        resolvedWindow.end >= total &&
        distanceToBottom <= BOTTOM_STICKY_THRESHOLD
      )
      if (node.scrollTop <= WINDOW_EDGE_THRESHOLD && resolvedWindow.start > 0) {
        shiftWindow('backward')
      } else if (
        distanceToBottom <= WINDOW_EDGE_THRESHOLD &&
        resolvedWindow.end < total
      ) {
        shiftWindow('forward')
      }
    }

    node.addEventListener('scroll', handleScroll, { passive: true })
    return () => node.removeEventListener('scroll', handleScroll)
  }, [resolvedWindow, shiftWindow, total])

  useLayoutEffect(() => {
    const node = scrollRef.current
    const anchor = pendingAnchorRef.current
    if (!node || !anchor) return
    const row = findWindowRow(node, anchor.key)
    if (row) {
      node.scrollTop = compensateMessageScrollTop(
        node.scrollTop,
        anchor.top,
        row.getBoundingClientRect().top,
      )
    }
    pendingAnchorRef.current = null
    unlockWindowShift()
  }, [
    resolvedWindow.end,
    resolvedWindow.start,
    unlockWindowShift,
  ])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !shouldStickToBottomRef.current) return
    node.scrollTop = node.scrollHeight
  }, [
    latestVersion,
    resolvedWindow.end,
    resolvedWindow.start,
    total,
  ])

  useEffect(() => () => {
    if (unlockFrameRef.current != null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(unlockFrameRef.current)
      } else {
        window.clearTimeout(unlockFrameRef.current)
      }
    }
    resizeObserverRef.current?.disconnect()
  }, [])

  const registerRow = useCallback((key: string, node: HTMLDivElement) => {
    const saveMeasurement = (nextSize: number) => {
      if (nextSize <= 0) return
      const previousSize = measuredSizesRef.current.get(key)
      if (previousSize != null && Math.abs(previousSize - nextSize) < 0.5) return
      measuredSizesRef.current.set(key, nextSize)
      const scrollNode = scrollRef.current
      if (
        scrollNode &&
        previousSize != null &&
        !shouldStickToBottomRef.current &&
        node.getBoundingClientRect().bottom <= scrollNode.getBoundingClientRect().top + 1
      ) {
        scrollNode.scrollTop += nextSize - previousSize
      }
    }
    const measure = () => saveMeasurement(node.getBoundingClientRect().height)
    let toggleFrame: number | null = null
    const handleToggle = () => {
      if (toggleFrame != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(toggleFrame)
      }
      const run = () => {
        toggleFrame = null
        measure()
      }
      toggleFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : window.setTimeout(run, 0)
    }
    node.addEventListener('toggle', handleToggle, true)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (toggleFrame != null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(toggleFrame)
        } else if (toggleFrame != null) {
          window.clearTimeout(toggleFrame)
        }
        node.removeEventListener('toggle', handleToggle, true)
        measuredSizesRef.current.delete(key)
      }
    }
    if (!resizeObserverRef.current) {
      resizeObserverRef.current = new ResizeObserver((observedEntries) => {
        for (const observedEntry of observedEntries) {
          const observedNode = observedEntry.target as HTMLDivElement
          const observedKey = observedNode.dataset.windowKey
          if (!observedKey) continue
          const nextSize = borderBlockSize(observedEntry)
          if (nextSize <= 0) continue
          const previousSize = measuredSizesRef.current.get(observedKey)
          if (previousSize != null && Math.abs(previousSize - nextSize) < 0.5) continue
          measuredSizesRef.current.set(observedKey, nextSize)
          const scrollNode = scrollRef.current
          if (
            scrollNode &&
            previousSize != null &&
            !shouldStickToBottomRef.current &&
            observedNode.getBoundingClientRect().bottom <=
              scrollNode.getBoundingClientRect().top + 1
          ) {
            scrollNode.scrollTop += nextSize - previousSize
          }
        }
      })
    }
    resizeObserverRef.current.observe(node)
    return () => {
      if (toggleFrame != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(toggleFrame)
      } else if (toggleFrame != null) {
        window.clearTimeout(toggleFrame)
      }
      node.removeEventListener('toggle', handleToggle, true)
      resizeObserverRef.current?.unobserve(node)
      measuredSizesRef.current.delete(key)
    }
  }, [])

  return {
    registerRow,
    scrollRef,
    window: resolvedWindow,
  }
}
