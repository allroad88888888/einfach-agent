import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { openSettingsCenter } from '../../mcp/commands'
import { settingsCenterOpenAtom } from '../../mcp/state'

const SettingsDialog = lazy(() => import('./SettingsDialog').then((module) => ({
  default: module.SettingsDialog,
})))

/** Opens the settings dialog without loading its panels before the first use. */
export function SettingsCenter() {
  const open = useAtomValue(settingsCenterOpenAtom)
  const launchButtonRef = useRef<HTMLButtonElement>(null)
  const [hasOpened, setHasOpened] = useState(open)

  useEffect(() => {
    if (open) setHasOpened(true)
  }, [open])

  return (
    <>
      <button
        ref={launchButtonRef}
        type="button"
        className="agentnew-settings-launch"
        aria-label="打开设置"
        onClick={() => openSettingsCenter()}
      >
        <span aria-hidden="true">⚙</span>
        设置
      </button>
      {hasOpened ? (
        <Suspense fallback={null}>
          <SettingsDialog launchButtonRef={launchButtonRef} />
        </Suspense>
      ) : null}
    </>
  )
}
