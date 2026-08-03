const PUBLIC_MODEL_CREDENTIAL_NAMES = ['VITE_DEEPSEEK_API_KEY', 'VITE_GLM_API_KEY'] as const

/** Refuses credentials that Vite would otherwise make available to browser code. */
export function assertNoPublicModelCredentials(environment: Record<string, string | undefined>): void {
  const publicCredentials = PUBLIC_MODEL_CREDENTIAL_NAMES.filter((name) => Boolean(environment[name]?.trim()))
  if (publicCredentials.length === 0) return

  throw new Error(
    `公开的模型凭据变量不受支持：${publicCredentials.join(', ')}。请改用无 VITE_ 前缀的服务端环境变量。`,
  )
}
