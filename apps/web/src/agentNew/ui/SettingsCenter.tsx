import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { useLingui } from '@lingui/react/macro'
import { openSettingsCenter } from '../../settings/commands'
import { settingsCenterOpenAtom } from '../../settings/state'

const SettingsDialog = lazy(() => import('./SettingsDialog').then((module) => ({
  default: module.SettingsDialog,
})))

/** Opens the settings dialog without loading its panels before the first use. */
export function SettingsCenter() {
  const { t } = useLingui()
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
        aria-label={t`打开设置`}
        onClick={() => openSettingsCenter()}
      >
        <span aria-hidden="true">⚙</span>
        {t`设置`}
      </button>
      {hasOpened ? (
        <Suspense fallback={null}>
          <SettingsDialog launchButtonRef={launchButtonRef} />
        </Suspense>
      ) : null}
    </>
  )
}
