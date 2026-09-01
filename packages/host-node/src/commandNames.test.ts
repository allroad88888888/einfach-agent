import { describe, expect, it } from 'vitest'
import {
  NODE_HOST_COMMANDS_BY_DOMAIN,
  NODE_HOST_COMMAND_NAMES,
  isNodeHostCommandName,
} from './commandNames'

// 【T1 删掉了两条对拍用例，理由与替代物】
// 本文件此前的两条主力用例**读 `apps/desktop/src/lib.rs`**，把 Node 侧的命令全集与桌面宿主
// `tauri::generate_handler![…]` 的登记列表逐字比对，堵的是「Rust 侧加了命令、Node 侧永远不知道
// 该实现它」这种静默漂移。桌面端整条退出后那份上游权威不存在了，对拍没有第二侧可比。
//
// **没有拿别的东西替代它，是因为漂移的方向反过来了。** 这份命令全集今天的下游是
// `apps/web`（`POST /api/invoke/:command`）与 `apps/cli`（进程内直调），两者都从
// `NODE_HOST_COMMAND_NAMES` 取名字——名字对不上是 `tsc -b` 的事，不是运行期的事。把那 28 条抄成
// 一份字面量放在这里只会变成「同一张表写两遍」，改一处忘另一处时它只会红得莫名其妙。
//
// 下面留着的四条钉的是表本身的自洽性（条数、无重复、域不共享、判定函数），它们与宿主是谁无关。

describe('命令全集', () => {
  it('sqlite 域是 Node 独有的两条', () => {
    // 【T1】此前这条还反向断言「这两条确实不在桌面宿主的登记列表里」——桌面侧的等价能力由
    // Tauri **插件**提供，从来不在 `generate_handler!` 里。桌面端退出后反向那一半没有比对对象，
    // 只留下「这个域就是这两条」这个仍然成立的事实。
    expect(NODE_HOST_COMMANDS_BY_DOMAIN.sqlite).toEqual(['sqlite_execute', 'sqlite_select'])
  })

  it('恰好 46 条，且没有重复', () => {
    // 后 16 条没有 Rust 对应物：sqlite 两条走的是 Tauri 插件而非 `generate_handler!`，
    // model_endpoint 三条（C6）是 openai-compat 的登记接入点——桌面宿主只认有官方接入点的
    // provider，压根没有「登记一个接入点」这件事。
    // profile 五条管理或探测独立第三方连接；rollout 两条追加/重放原始历史；history四条只读查询。
    expect(NODE_HOST_COMMAND_NAMES).toHaveLength(46)
    expect(new Set(NODE_HOST_COMMAND_NAMES).size).toBe(46)
  })

  it('域之间不共享命令名——一条命令只能有一个实现目录', () => {
    const seen = new Map<string, string>()
    for (const [domain, commands] of Object.entries(NODE_HOST_COMMANDS_BY_DOMAIN)) {
      for (const command of commands) {
        expect(seen.get(command), `${command} 同时登记在 ${seen.get(command)} 与 ${domain}`)
          .toBeUndefined()
        seen.set(command, domain)
      }
    }
  })

  it('isNodeHostCommandName 对全集内为真、对近似名为假', () => {
    for (const command of NODE_HOST_COMMAND_NAMES) expect(isNodeHostCommandName(command)).toBe(true)
    expect(isNodeHostCommandName('read_workspace_fil')).toBe(false)
    expect(isNodeHostCommandName('readWorkspaceFile')).toBe(false)
    // 不能被 Object.prototype 上的键蒙混过去（Set 判定天然安全，这条钉住它不被改成对象查表）。
    expect(isNodeHostCommandName('toString')).toBe(false)
    expect(isNodeHostCommandName('constructor')).toBe(false)
  })
})
