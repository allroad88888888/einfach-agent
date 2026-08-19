#!/usr/bin/env node
// 构建收尾（D1）：把 vite 构建出的 `apps/web/dist` 复制进本包自己的 `dist/public`，
// 让 `npm pack` 出的 tarball 自带前端产物，不依赖仓库工作树。
//
// 只做这一件事：读一个已经存在的目录、复制进本包 dist 下。不解析 vite 配置、不重新构建
// 前端——那是根 `pnpm build` 里 `vite build` 那一步的职责，本脚本只负责「之后」。
//
// **必须排在 tsup 之后跑**（见 package.json 的 `"build": "tsup && node scripts/embed-web-dist.mjs"`）：
// tsup 的 `clean: true` 会先清空 `dist/`，先复制再跑 tsup 会把这份产物一并清掉。
//
// **必须排在 `vite build` 之后跑**：根 `pnpm build` 的脚本把 `vite build` 放在
// `pnpm --filter @web-agent/server build` 之前，保证复制时 `apps/web/dist` 是这次 build
// 刚产出的那份，不是更早一次的陈旧产物。若单独在 `apps/server` 下跑 `pnpm build`
// （不经根脚本），源目录多半还没生成——此时直接报错退出，而不是复制一份不存在或过期的东西。
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const webDistDirectory = resolve(packageRoot, '../web/dist')
const targetDirectory = resolve(packageRoot, 'dist/public')

if (!existsSync(webDistDirectory)) {
  console.error(
    `[embed-web-dist] 找不到 ${webDistDirectory}。\n` +
      '请先在仓库根目录跑一次 `pnpm build`（它按顺序先跑 vite build 再跑本包的 build），' +
      '不要单独在 apps/server 下跑 build 而没先构建过前端。',
  )
  process.exit(1)
}

await mkdir(dirname(targetDirectory), { recursive: true })
await cp(webDistDirectory, targetDirectory, { recursive: true })
console.log(`[embed-web-dist] 已把 ${webDistDirectory} 复制进 ${targetDirectory}`)
