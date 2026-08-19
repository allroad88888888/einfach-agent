// 宿主能力桥（host bridge）的注入点 —— H 线的根，H2–H5 会把 core 里 13 个 runtime 模块
// （`workspaceRead/Write/Patch/Delete/PathOperation/Rg/Git/Change/Task`、`shellCommand`、
// `projectSkillsBridge`、`modelTurnPrefix`、`workspaceDialog`）从 hostTauri 的两个导出换到这里。
//
// 换的是什么：那 13 个模块此前每处都写着
//   `if (!isTauriHost()) return fail(...)` + `const invoke = await loadTauriInvoke()`，
// 于是「当前宿主有没有文件与 shell 能力」被硬编码成了「是不是跑在 Tauri webview 里」。本文件把这两个
// 问题拆开：core 只问「宿主登记过桥没有」（hasHostBridge）和「把桥拿来」（loadHostInvoke），至于桥
// 背后是 Tauri invoke、HTTP 请求还是 Node 进程内直连，全由装配层用 configureHostInvoke 决定。
//
// 本文件是**宿主中立**的：整份源码里连桌面那个上游包的名字都不出现（连注释与类型位置也不出现，
// 因为下面 HostInvokeLoader 的 JSDoc 会被 tsc 原样带进发布物 .d.ts —— hostTauri.ts D9 那条
// 「.d.ts 里该字符串零命中」的纪律，在这里是更强的「本模块与那个包全无关系」）。
//
// H5 落地时改了一处：桌面装配层**没有**去包 hostTauri.ts 的 loadTauriInvoke，而是自己持有
// 那个 loader（apps/web/src/main.tsx 里 configureHostInvoke 的唯一调用点）。原因是
// loadTauriInvoke 不在 `@web-agent/core` 的公开面上，深导入 `runtime/hostTauri` 会撞
// check-boundaries 的 core 公开面白名单（S9），而桌面装配层本来就直接依赖那个上游包、
// 自己写一行 loader 不欠任何东西。这对本文件只有一个后果，且正是想要的那个：core 自身
// 不再认识桌面宿主，一处也不。
// 副作用是 loadTauriInvoke 目前**零生产消费方**（isTauriHost 仍被 workspaceDialog 用着），
// 要不要连它一起删是 hostTauri.ts 自己的事，留给后续卡。
//
// S5 之后本模块多担一件事：桥登记时把宿主平台一并写进 `runtime/hostPlatform.ts` 的权威位。
// 它不是「顺手放这儿」——平台必须与桥同生共死，而唯一知道桥何时生灭的就是这里。
import { declareHostPlatform, type HostPlatform } from './hostPlatform'

/**
 * 宿主命令通道的调用签名。形状对齐现有全部调用点：它们一律写成
 * `invoke<unknown>('<command_name>', argsRecord)`，带类型实参、只传两个参数，从不传第三个
 * options ——**泛型形态必须保留**，非泛型的类型会让那些带类型实参的调用点全体报错。
 *
 * 参数按逆变检查，所以一个更宽的真实实现（比如上游 Tauri 的
 * `invoke<T>(cmd, args?: InvokeArgs, options?)`，其 args 是含 `Record<string, unknown>` 的联合）
 * 结构上兼容这个更窄的契约，装配层无需断言即可直接注入；反过来，Node/HTTP 侧新写的实现按这个
 * 签名实现就够，不必去兑现 Tauri 的联合参数。
 */
export type HostInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/**
 * 注入的是 **loader（`() => Promise<HostInvoke>`）而不是已解析的 invoke**。
 *
 * 理由是时序：装配层要拿到 invoke 本身是异步的（桌面侧要先 await 一次上游 core 模块的动态 import，
 * HTTP/Node 侧同样可能要先 await 一次动态 import 或握手）。若本模块只收已解析值，装配层就必须
 * 先 await 再登记，那段 await 期间 `hasHostBridge()` 仍答 false —— 而工具随时可能执行，于是
 * 「工具在注入完成前跑」从一个可以被结构排除的问题退化成一个**时序竞态**：偶发、只在冷启动
 * 抢跑时命中、且表现为「文件工具报宿主不支持」这种看起来像环境问题的假象。
 * 收 loader 则登记是同步的、一步到位：装配层调完 configureHostInvoke 的那一刻 hasHostBridge()
 * 就为 true，真正的解析推迟到第一次实际调用（也天然保住了惰性加载）。
 */
type HostInvokeLoader = () => Promise<HostInvoke>

/**
 * 一次桥登记 —— **loader 与平台是一对，不能分开登记**（S5）。
 *
 * 平台是必填字段，理由在 `runtime/hostPlatform.ts` 的文件头：那个值有两个消费者（shell 桥的
 * `platform` 入参、注入给模型的「运行环境」段），而校验它的是**执行命令的那台机器**。把它挂在
 * 桥的登记上，「组命令用的事实」与「执行命令的机器」就来自同一次声明、同一个持有者，且同时
 * 生效、同时作废；漏写是编译错误而不是一个到运行期才现形的空值。
 *
 * 于是远端宿主（浏览器 → Node server）的握手顺序被**结构性地**定了下来：拿到平台之前登记不了
 * 桥，登记不了桥就没有本机能力——那正是「握手是启动的一道门」。B 线接的时候不需要额外守卫。
 */
export interface HostBridgeRegistration {
  readonly loader: HostInvokeLoader
  /** 宿主自己是什么平台。同机宿主（Tauri）可用 `detectLocalPlatform()`，远端宿主必须取自握手。 */
  readonly platform: HostPlatform
}

let hostInvokeLoader: HostInvokeLoader | undefined

// 解析结果的 promise 缓存。必须缓存（下方 `??=`）的理由逐字同 hostTauri.ts 的 tauriCoreModule：
// loader 内部通常是一次动态 import，同一 tick 内并发发起首次 import 时，Vitest 4 的 mocker 有一路
// 可能拿到未被替换的真模块（实测 SubagentTreePanel 的 run 索引与 candidate skills 两条 effect 同时
// 触发时命中，见 state/stateViewPort.ts 同款记档）；缓存后每个模块实例只解析一次，所有调用点
// 拿到的是同一个 invoke 引用。
let hostInvokePromise: Promise<HostInvoke> | undefined

/**
 * 登记（或重置）宿主命令桥。宿主装配层在启动时调用一次，必须早于任何工具可能执行的时点；
 * 传 `undefined` 表示重置回「没有桥」（测试在用例之间还原现场，以及宿主主动退出桥的场景）。
 *
 * 收的是 `{ loader, platform }` 而不是裸 loader：见 `HostBridgeRegistration` 的说明。
 *
 * 登记会**作废已有的解析缓存**：不作废的话，测试里换宿主、或运行期切换桥，都会继续拿到上一个
 * loader 解析出来的 invoke —— 那是「configure 看起来成功了、实际没生效」的静默错误。
 * 同理平台也随之改写/清空：桥换了而平台还停在上一任，就是「组命令按 A、执行在 B」本身。
 */
export function configureHostInvoke(registration: HostBridgeRegistration | undefined): void {
  hostInvokeLoader = registration?.loader
  hostInvokePromise = undefined
  declareHostPlatform(registration?.platform)
}

/**
 * 当前宿主是否登记过 host bridge。**同步可答**，且只看 loader 是否登记，不触发解析 ——
 * 13 个调用点拿它做「当前宿主有没有 workspace 桥」的早退判断，那些地方是同步分支
 * （`if (!hasHostBridge()) return fail(...)`），一旦要 await 就得把整条判断链改成异步。
 */
export function hasHostBridge(): boolean {
  return hostInvokeLoader !== undefined
}

/**
 * 取宿主 invoke：首次调用触发 loader，之后复用同一次解析。
 *
 * 未登记 loader 时**以 rejection 明确失败**，不返回任何兜底 invoke。两点说明：
 *   · 为什么不静默兜底：一个「什么都不做/恒失败」的假 invoke 会让调用点拿到一个语义不明的失败
 *     结果，真正的病因（宿主没装配）被埋在十几层调用之下。桥没配就是装配错误，要在第一现场喊。
 *   · 为什么是 reject 而不是同步 throw：本函数对外承诺返回 Promise，若在未登记时改走同步抛出，
 *     失败就有了两种形状 —— `loadHostInvoke().catch(...)` 这类不在 async 函数里的调用方会被
 *     同步异常绕过 catch 链，变成未捕获错误。统一成 rejection，调用方无论 await 还是 .catch
 *     都能接住。正常路径上这条分支根本不该被走到：调用点先用 hasHostBridge() 早退，能走到这里
 *     就说明有人跳过了守卫。
 */
export async function loadHostInvoke(): Promise<HostInvoke> {
  const loader = hostInvokeLoader
  if (!loader) {
    throw new Error(
      'No host invoke bridge is configured; call configureHostInvoke(loader) during host assembly.',
    )
  }
  // 缓存只缓存**成功**的解析：loader 抛错/reject 时把缓存清回 undefined，让下一次调用能重试。
  // 缓存住一个 rejected promise 会把一次偶发失败（动态 import 撞上网络抖动之类）固化成整个进程
  // 生命周期内的「桥永久坏掉」，而唯一的恢复手段是重新 configure —— 没有哪个调用点会去做这件事。
  // 清理前比对 promise 身份：期间若发生过 configureHostInvoke，缓存已经属于新 loader，不能被
  // 旧 loader 的失败清掉。
  const pending = (hostInvokePromise ??= loader().catch((error: unknown) => {
    if (hostInvokePromise === pending) hostInvokePromise = undefined
    throw error
  }))
  return pending
}
