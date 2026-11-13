import { useLingui } from '@lingui/react/macro'
import { hasHostBridge, setLocalAccessMode } from '@einfach-agent/core'
import { useActiveSessionConfig } from './ActiveSessionProvider'
import './ComposerLocalAccessControl.css'

/** Session-owned file access selection in the composer toolbar. */
export function ComposerLocalAccessControl({ disabled }: { disabled: boolean }) {
  const { t } = useLingui()
  const session = useActiveSessionConfig()
  if (!session || !hasHostBridge()) return null
  const mode = session.localAccessMode ?? 'workspace'
  return (
    <label
      className={`agentnew-local-access ${mode === 'full' ? 'is-full' : ''}`}
      title={disabled ? t`任务结束或停止后可切换本地权限` : mode === 'full'
        ? t`文件工具可访问本机目录外的文件，仍受系统权限限制`
        : t`文件工具仅可访问当前工作区目录`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5 13 3.5v4c0 3-2.5 5.5-5 7-2.5-1.5-5-4-5-7v-4L8 1.5Z" />
        <path d="m5.5 8 1.7 1.7 3.3-3.4" />
      </svg>
      <select
        aria-label={t`本地权限`}
        value={mode}
        disabled={disabled}
        onChange={(event) => setLocalAccessMode(event.target.value === 'full' ? 'full' : 'workspace')}
      >
        <option value="workspace">{t`目录内`}</option>
        <option value="full">{t`本地完整权限`}</option>
      </select>
      <svg className="agentnew-local-access-chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
      </svg>
    </label>
  )
}
