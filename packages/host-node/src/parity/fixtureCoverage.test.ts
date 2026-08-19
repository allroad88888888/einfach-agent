// fixtures/ 里的每份 JSON 都得有驱动器在跑
// ---------------------------------------------------------------------------
// 加一份 fixture 却忘了写驱动器，是这套对拍最容易出现的**静默缺席**：文件在仓库里、看着很像
// 被覆盖了，实际一例都没跑。反过来，驱动器指向一份不存在的 fixture 会在加载时响亮失败
// （loadParityFixture 直接抛），那一头不需要额外的守卫。
//
// 所以这里只钉一件事：**目录里的 `*.json` 集合 = 驱动器声明要跑的集合**。W17 加一组 fixture 时
// 会在这里红一次，提醒它把驱动器也加上。

import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 当前有驱动器在跑的 fixture。**新增一组要同时改这里**——顺序无关，比的是集合。
 *
 * 与各驱动器文件里那句 `loadParityFixture('…')` 是一份重复声明，但重复的是**文件名字符串**而不
 * 是逻辑：把它做成「从驱动器源码里 grep 出来」才是真正脆的做法（改个换行就失效），而漏改这张表
 * 的代价只是这条测试红一下。
 */
const drivenFixtures = [
  'change-batch-revert.json',
  'change-summary.json',
  'patch-pipeline.json',
  'patch-stage-rules.json',
  'read-limits.json',
  'write-limits.json',
]

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

describe('对拍 fixture 目录', () => {
  it('每份 JSON 都有驱动器在跑', () => {
    const onDisk = readdirSync(fixturesDirectory).filter((name) => name.endsWith('.json'))
    expect([...onDisk].sort()).toStrictEqual([...drivenFixtures].sort())
  })
})
