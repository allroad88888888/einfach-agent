// 默认版本号来源：本包自己的 package.json。
//
// 为什么在运行时读文件、而不是写一个常量：常量会和 package.json 漂移，而漂移的表现是
// health 报了一个**看起来正常**的错误版本——这类错误没有任何症状，只在排查别的问题时把人带偏。
//
// 为什么用 `import.meta.url` 定位而不是 `process.cwd()`：服务可以从任何目录启动（`npx web-agent`
// 更是如此），cwd 不是本包的位置。
//
// 读不到时回一个显眼的哨兵值而不是空串或抛异常：健康检查**必须**在打包形态出问题时仍然可答
// ——它恰好是那时唯一能问的东西；而哨兵值让 B1 的宿主探测一眼看出「服务活着但打包坏了」。
// 分发形态（谁的版本号才是权威）由 D 线决定，那时装配层显式传 `version` 覆盖即可。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNKNOWN_VERSION = '0.0.0-unknown'

// 不用 `new URL('../package.json', import.meta.url)`：Vite 会把这个字面量形态当资源引用静态改写
// （见 createServer.ts 里同一条注释）。
export const SERVER_MANIFEST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')

let cached: string | undefined

function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(SERVER_MANIFEST_PATH, 'utf8'))
    if (typeof manifest === 'object' && manifest !== null) {
      const version = (manifest as { version?: unknown }).version
      if (typeof version === 'string' && version !== '') return version
    }
  } catch {
    // 落到哨兵值。
  }
  return UNKNOWN_VERSION
}

export function resolveServerVersion(): string {
  cached ??= readVersion()
  return cached
}
