// Node 宿主的装配槽：宿主启动时要注入的全部「本机事实」
// ---------------------------------------------------------------------------
// `createNodeHostInvoke(options)` 收到的就是这一份。单独成文件而不是塞进
// createNodeHostInvoke.ts，是因为后面 24 张卡每张都要往这里加槽位（工作区根、变更日志目录、
// MCP 进程管理器、模型凭证源、事件出口、SQLite 句柄……），每个槽位都得写清「不传会怎样」。
// 让路由表文件跟着长下去，它会在第 5 张卡左右顶破 300 行，而它本来只该负责分发这一件事。
//
// 【定槽位的三条纪律】（写给后面 24 张卡）
//   1. **可选槽位必须写明缺省行为**，而且缺省行为只能是「有一个明确的本机默认」或「这条命令
//      直接以 NodeHostCommandError 失败」，不能是「返回一个看起来正常的空结果」。
//   2. **不要为「能自己算出来的东西」开槽位**。开一个槽等于多一个权威；两个权威漂移时的症状
//      通常是功能悄悄失效，不是报错。本卡拒绝把主目录放进 `/api/health` 就是这条。
//   3. 槽位类型只用 Node 侧能独立表达的东西。要 `import type` core 的类型可以，但不许引入
//      core 的运行时——本包在依赖树上是能力包，不是应用层。

import type { McpHostEventEmitter } from './mcp/lifecycle'
import type { WorkspaceDirectoryPicker } from './workspace/dialog/nativeDirectoryPicker'

/**
 * 宿主装配槽。全部可选；`createNodeHostInvoke()` 与 `createNodeHostInvoke({})` 等价、
 * 都表示「全取默认」。
 */
export interface NodeHostInvokeOptions {
  /** User-initiated native folder chooser. Omit it to use macOS's system picker. */
  openWorkspaceDirectory?: WorkspaceDirectoryPicker

  /**
   * 用户主目录的**绝对路径**。不传 → 用 `os.homedir()`。
   *
   * 为什么留这个槽而不是写死 `os.homedir()`：
   *   · server 宿主可能以服务账号身份跑（systemd / 容器），进程的 HOME 未必是「用户的」主目录，
   *     而这个值会被 core 当作用户级 skills 的扫描根与配置文件的根一起用下去。
   *   · CLI 宿主已经在装配层自己解析过主目录（见 core 的 runtime/userSkillsRoot.ts 注释），
   *     有槽位它就能把同一个值传进来，而不是让两处各调一次 `homedir()` 各得各的。
   *   · 测试要能不碰进程环境地固定这个值。
   *
   * 传空串或全空白等同于不传（当作没配置，回落到 `os.homedir()`）——把空串原样当成路径根用，
   * 后续所有拼接都会指向文件系统根，且不会报错。
   */
  homeDir?: string

  /**
   * MCP 生命周期事件的出口（C1 发、C2 的事件汇收）。不传 → 事件丢弃，连接照常可用，
   * 只是外界收不到「工具变了」「连接掉了」。
   *
   * 形状是 `(event: { name, payload }) => void`，而 `createHostEventBus()` 的汇是
   * `emitHostEvent(name, payload)`——两者刻意不同名不同形：C1 的传输层**只该拿到发射面**，
   * 拿到订阅面就等于给「事件回环驱动状态」留了口子。装配层写一行适配即可：
   *
   * ```ts
   * const bus = createHostEventBus()
   * createNodeHostInvoke({ emitHostEvent: (e) => { bus.emitHostEvent(e.name, e.payload) } })
   * ```
   */
  emitHostEvent?: McpHostEventEmitter

  /**
   * 关停钩子：装配层拿到 `dispose` 后挂进**自己的**信号处理。不传 → 只剩进程 `exit` 那道兜底。
   *
   * **不传是有真实后果的**：Node 对没有 listener 的 SIGTERM/SIGINT 走默认处置，`'exit'` 回调
   * 根本不执行（C1 已用探针实测），于是 `SIGTERM` 停服会**漏下 MCP 子进程**。能力包刻意不自己
   * 装信号处理器——装 SIGINT 会改掉宿主语义（CLI REPL 的 Ctrl-C 是「中断本轮」不是「退出」），
   * 而这类隐式全局正是本仓库反复吃过亏的形态。所以责任显式交给装配层。见树上 C5。
   */
  registerHostDisposer?: (dispose: () => Promise<void>) => void
}
