// 进程入口：只负责调用编排层并把失败翻译成退出码。真正的逻辑都在 `mainRunServer.ts`
// 及其依赖的 `main*.ts` 兄弟文件里——这一层薄得没有值得单独测试的分支，同 `apps/cli/src/main.ts`
// 的角色分工。

import { runServerCli } from './mainRunServer'

runServerCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`错误：${message}\n`)
  process.exitCode = 1
})
