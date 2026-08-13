import { register } from 'node:module'

register(new URL('./raw-module-loader.mjs', import.meta.url), import.meta.url)

void import('./bootstrap')
  .then(({ main, reportCliError }) => main().catch((error: unknown) => {
    reportCliError(error)
    process.exitCode = 1
  }))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`错误：${message}\n`)
    process.exitCode = 1
  })
