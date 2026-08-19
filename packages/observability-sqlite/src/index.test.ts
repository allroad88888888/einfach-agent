// 本包的公开面就是这五条。
// ---------------------------------------------------------------------------
// `configureTraceSqlExecutor` 尤其要钉住：包内**没有任何一处**从 barrel 取它，唯一的消费方是
// 宿主装配层（`apps/web/src/host/hostObservability.ts`）。把它从 barrel 里漏掉，包内 38 条用例
// 一条都不会红、`tsc` 也照过，症状要到装配层写下那行 import 才浮出来——而在那之前，
// 「driver 已收敛」这个结论看起来完全成立。
// 反过来也一样：多出一条导出（比如顺手把 `getTraceDb` 漏出去）等于给调用方一条绕开注入面的路。

import { describe, expect, it } from 'vitest'
import * as barrel from './index'

describe('@einfach-agent/observability-sqlite 的公开面', () => {
  it('恰好导出这五个名字', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      '__resetSqliteLogForTest',
      'configureTraceSqlExecutor',
      'createDevSqliteLogReader',
      'createSqliteLogDriver',
      'createSqliteLogReader',
    ])
  })

  it('五个都是函数', () => {
    for (const [name, value] of Object.entries(barrel)) {
      expect(typeof value, name).toBe('function')
    }
  })
})
