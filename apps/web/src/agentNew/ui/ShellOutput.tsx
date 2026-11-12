import './shell-output.css'
import { useLayoutEffect, useRef } from 'react'
import { useLingui } from '@lingui/react/macro'

/** Temporary output follows the tail until the reader scrolls up. */
export function ShellOutput({ text, truncated }: { text: string; truncated?: boolean }) {
  const { t } = useLingui()
  const ref = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    if (follow.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <>
      {truncated && <small className="agentnew-shell-output-notice">{t`仅显示最近的输出`}</small>}
      <pre
        ref={ref}
        className="agentnew-shell-output"
        aria-label={t`Shell 实时输出`}
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >{text}</pre>
    </>
  )
}
