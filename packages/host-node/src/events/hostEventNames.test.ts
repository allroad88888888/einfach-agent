import { describe, expect, it } from 'vitest'
import { HOST_EVENT_NAMES, isHostEventName } from './hostEventNames'
import { HOST_EVENT_PAYLOAD_KEYS } from './hostEventPayloads'

// 【T1 删掉了三条对拍用例，理由与替代物】
// 本文件此前的三条主力用例**读 `apps/desktop/src/mcp_lifecycle.rs`**：那里的两个 `const &str`
// 是线上的事件名，两个 `#[serde(rename_all = "camelCase")]` struct 是线上的载荷形状，逐字对拍
// 堵的是「Rust 侧改了名字/加了字段，Node 侧永远不知道」这种静默漂移。桌面端整条退出后那份上游
// 权威不存在了，对拍没有第二侧可比。
//
// **今天这份声明就是权威本身**，而它的下游只有一个：`apps/web/src/mcp/serverHostEventStream.ts`
// 按同一组名字与键解析 SSE。两侧都从本模块与 `hostEventPayloads.ts` 取值，对不上是 `tsc -b`
// 的事——把那两个 struct 抄成字面量放在这里只会是「同一张表写两遍」。
//
// 下面留着的用例钉的是表本身的自洽性（条数、无重复、判定函数拒近似名与原型键），与宿主是谁无关。
// 载荷键那一条改成钉「两个事件都有声明、且键集合非空」——它守的是「新增事件忘了声明载荷」。

describe('宿主事件名', () => {
  it('恰好两条且没有重复', () => {
    expect(HOST_EVENT_NAMES).toHaveLength(2)
    expect(new Set<string>(HOST_EVENT_NAMES).size).toBe(2)
  })

  it('isHostEventName 对全集内为真、对近似名与原型键为假', () => {
    for (const name of HOST_EVENT_NAMES) expect(isHostEventName(name)).toBe(true)
    // 少一个字母的名字：开放字符串下它是一条永不触发的死订阅，这里必须判假。
    expect(isHostEventName('mcp-stdio-clos')).toBe(false)
    expect(isHostEventName('mcpStdioClose')).toBe(false)
    expect(isHostEventName('')).toBe(false)
    // Set 判定天然不吃 Object.prototype 的键；这两条钉住它不被改成对象查表。
    expect(isHostEventName('toString')).toBe(false)
    expect(isHostEventName('constructor')).toBe(false)
    // 非字符串输入（线上读回来的字段未必是 string）。
    expect(isHostEventName(undefined)).toBe(false)
    expect(isHostEventName(null)).toBe(false)
    expect(isHostEventName(42)).toBe(false)
  })
})

describe('宿主事件载荷', () => {
  it('每个事件名都声明了载荷键，且键集合非空', () => {
    // 【T1】此前这两条用例比的是「与 Rust struct 的字段逐字一致」和「struct 上带
    // rename_all = camelCase」。上游没了，剩下能守的是**这张表与事件名全集不脱节**：
    // 新增一条事件却忘了声明它的载荷键时，消费方（serverHostEventStream.ts）会解析出一个
    // 空对象，而那是静默的。
    for (const name of HOST_EVENT_NAMES) {
      const keys = HOST_EVENT_PAYLOAD_KEYS[name]
      expect(keys, `${name} 没有声明载荷键`).toBeDefined()
      expect(keys.length, `${name} 的载荷键是空的`).toBeGreaterThan(0)
      // 键必须是 camelCase：线上载荷就是这个形状，写成 snake_case 会让消费方读到 undefined。
      for (const key of keys) expect(key, `${name} 的载荷键 ${key} 不是 camelCase`).not.toMatch(/_/)
    }
  })

  it('载荷表不含事件名全集之外的键', () => {
    expect(Object.keys(HOST_EVENT_PAYLOAD_KEYS).sort()).toEqual([...HOST_EVENT_NAMES].sort())
  })
})
