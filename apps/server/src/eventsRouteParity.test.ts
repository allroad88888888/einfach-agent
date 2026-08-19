// 判据正面比对：**同一个事件，进程内订阅者拿到的值，与从 SSE 帧解析回来的值，逐字段相同。**
// ---------------------------------------------------------------------------
// 这是 C3 卡面判据的那一句，单独成文件是因为它测的不是「端点能用」而是「两条传输是同一个契约」
// ——一旦它红了，问题不在 HTTP 层面而在「谁在中间动了载荷」。
//
// 【为什么用 `node:assert` 的 `deepStrictEqual` 而不是 vitest 的 `toEqual`】
// 照抄 C2 的记档：vitest 的 `toEqual` 认为 `{ a: undefined }` 等于 `{}`，而那**正是**这里要抓的
// 分岔——一个值为 `undefined` 的键在进程内是「键存在」、过了 `JSON.stringify` 是「键消失」。
// 用 `toEqual` 的话这条最典型的变形会绿着过去。`deepStrictEqual` 连原型都比。
//
// 【比的是值不是身份】C2 的 `jsonPayload.ts` 文件头明确写了对象身份不在契约内：进程内 handler
// 拿到的是发射方那个对象本身，SSE 那头每个客户端各 `JSON.parse` 出一份新的。所以这里断言的是
// 结构相等，不是 `===`。
//
// 【为什么还要比键的顺序】`Object.keys` 逐一相等能抓住一类 `deepStrictEqual` 抓不住的事：
// 服务端「顺手整形」——给缺失字段补个默认值、把某个键改名、删掉一个空字段。补默认值会多一个键
// （`deepStrictEqual` 能抓到），但**改顺序**这种更轻微的改写说明有人在中间重建过对象，
// 而重建就是分岔的起点。JSON 保留字符串键的插入顺序，所以这条断言是稳的。

import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import {
  createHostEventBus,
  isHostEventName,
  type HostEventName,
  type HostEventPayload,
} from '@web-agent/host-node'
import { openSseClient, startEventsRouteTestServer } from './eventsRoute.testHarness'

/**
 * 发一条事件，同时从两条路收回来：`onHostEvent` 直接拿到的对象，与 SSE 帧解析出来的对象。
 */
async function captureBothPaths<Name extends HostEventName>(
  name: Name,
  payload: HostEventPayload<Name>,
): Promise<{ inProcess: unknown; overHttp: unknown; eventField: string }> {
  const reported: unknown[] = []
  const bus = createHostEventBus({ onHandlerError: (error) => { reported.push(error) } })
  const received: unknown[] = []
  bus.onHostEvent(name, (value) => { received.push(value) })

  const server = await startEventsRouteTestServer({ events: bus, heartbeatIntervalMs: 0 })
  try {
    const client = await openSseClient(server.port)
    await client.waitForComment(0)
    bus.emitHostEvent(name, payload)
    const frame = await client.waitForEvent(0)
    client.disconnect()
    assert.deepStrictEqual(reported, [], '派发过程中不应有 handler 出错')
    assert.strictEqual(received.length, 1, '进程内订阅者应当恰好收到一条')
    return { inProcess: received[0], overHttp: JSON.parse(frame.data), eventField: frame.event }
  } finally {
    await server.close()
  }
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>)
}

describe('进程内 与 SSE 逐字段相同', () => {
  it('mcp-stdio-tools-changed', async () => {
    const payload = { serverId: 'srv-a', sessionToken: 'tok-a' }
    const { inProcess, overHttp, eventField } = await captureBothPaths('mcp-stdio-tools-changed', payload)
    assert.deepStrictEqual(overHttp, inProcess)
    assert.deepStrictEqual(keysOf(overHttp), keysOf(inProcess))
    expect(eventField).toBe('mcp-stdio-tools-changed')
  })

  it('mcp-stdio-close', async () => {
    const payload = { serverId: 'srv-b', sessionToken: 'tok-b', message: 'MCP 子进程已退出（退出码 1）。' }
    const { inProcess, overHttp, eventField } = await captureBothPaths('mcp-stdio-close', payload)
    assert.deepStrictEqual(overHttp, inProcess)
    assert.deepStrictEqual(keysOf(overHttp), keysOf(inProcess))
    expect(eventField).toBe('mcp-stdio-close')
  })

  it('message 里塞满会破坏 SSE 分帧的字符，两侧仍然逐字相同', async () => {
    // 载荷类型只有字符串字段，所以「难缠的值」只能从字符串内容上造。这一串把已知会咬人的
    // 东西全放进来：SSE 的三种行分隔符、能伪造一整帧的空行 + 字段行、JSON 要转义的引号与
    // 反斜杠、控制字符、代理对（emoji）、以及 U+2028/U+2029（`JSON.stringify` **不**转义它们，
    // 而它们在 SSE 里不算行分隔符——两边都不该把它当换行处理）。
    const message = [
      '第一行',
      'CR 之后：\r回车',
      'CRLF 之后：\r\n换行',
      '空行伪造一帧：\n\nevent: mcp-stdio-tools-changed\ndata: {"forged":true}\n\n',
      '引号 " 反斜杠 \\ 制表 \t 退格 \b 空字符 \u0000',
      '行分隔符 \u2028 段分隔符 \u2029',
      'emoji 🧨🎈 与 CJK 中文，以及尾随空格   ',
    ].join('')
    const payload = { serverId: 'srv-c', sessionToken: 'tok-c', message }
    const { inProcess, overHttp } = await captureBothPaths('mcp-stdio-close', payload)
    assert.deepStrictEqual(overHttp, inProcess)
    assert.deepStrictEqual(keysOf(overHttp), keysOf(inProcess))
    // 顺带把「伪造帧没有生效」在这一层再钉一次：真收到两条事件的话上面 waitForEvent(0)
    // 拿到的仍是第一条，只有这里能看出正文被截断了。
    assert.strictEqual((overHttp as { message: string }).message, message)
  })

  it('空串字段不会在任何一侧变成缺席或 null', async () => {
    // 「整形」最常见的形态：看到空串就当没有。两侧都必须原样保留这三个键。
    const payload = { serverId: '', sessionToken: '', message: '' }
    const { inProcess, overHttp } = await captureBothPaths('mcp-stdio-close', payload)
    assert.deepStrictEqual(overHttp, inProcess)
    assert.deepStrictEqual(keysOf(overHttp), ['serverId', 'sessionToken', 'message'])
  })

  it('SSE 帧读回来的 event 字段用 isHostEventName 判，不是 as', async () => {
    // C2 明确交代：收端读回来的是 `string`，判定要用运行期判据。这条用例把那个用法钉在
    // 端点的输出上——`event:` 字段必须恰好是全集里的名字。
    const { eventField } = await captureBothPaths('mcp-stdio-close', {
      serverId: 's', sessionToken: 't', message: 'm',
    })
    expect(isHostEventName(eventField)).toBe(true)
  })
})
