// 宿主平台这一个事实的唯一权威（同步可答、无副作用）。
// ---------------------------------------------------------------------------
// ★ 为什么收口成一处 ★ —— 这个值有两个消费者，且必须逐字一致：
//   · shell 桥要求调用方传 platform，宿主侧会拒绝与自己不符的值
//     （今天只有一个：`packages/host-node/src/shell/pipeline.ts`；另一侧是桌面宿主的
//     `shell_pipeline.rs`，已随 T1（提交 `e52c31d`）删除
//     各一份，文案同为 ``platform mismatch: requested `X`, current `Y` ``）；
//   · 注入给模型的「运行环境」段也要报同一个平台，模型据它在 shell_macos / shell_linux /
//     shell_powershell 三个工具里挑一个。
//   两边各写一份，任何一次改动都可能让「告诉模型的平台」与「实际执行的平台」漂移，于是模型按
//   A 平台组命令、桥按 B 平台拒绝。故本模块是唯一真相源，tools-* 也从这里导入。
//
// ★ S5：为什么不能再由调用方探测 ★ ——
// 这个函数原本只做一件事：看 `navigator.userAgent`，回落 `process.platform`。那是在问**跑
// core 的那台机器**是什么平台，而校验它的是**执行命令的那台机器**。Tauri 下两者同机，这条恒
// 成立；浏览器 → Node server 这条路上不成立（用户在 macOS、服务端在 Linux），于是每一条 shell
// 命令都稳定撞上 platform mismatch，`run_shell_command` 在 server 宿主下整个不可用。
// 那条校验挡的是真问题（模型按 A 平台组命令、宿主按 B 平台执行），删不得。正解是换权威：
// **平台由宿主自己声明，与命令桥同一次登记**（见下）。
//
// ★ 「忘了声明」为什么不可能发生 ★ ——
// 平台不是一个独立的登记项，而是 `configureHostInvoke` 的**必填字段**：宿主登记桥的那一刻就
// 必须一并说出自己是什么平台，两者在同一次调用里原子地一起生效、一起作废。于是不存在
// 「登记了桥但平台还没到」的窗口，也不存在「忘了登记平台」这种运行期状态——漏写是**编译错误**，
// 在唯一的装配调用点上，跑都跑不起来。这比任何运行期告警都响亮。
//
// 反过来「没有桥」时回落本地探测是安全的，而不是静默地错：没有桥就没有任何机器会执行命令
// （shell 工具早退、也不进模型的工具清单），此刻这个值只用于「运行环境」段里如实告诉模型
// 用户自己坐在哪种机器前，没有第二个权威可与之矛盾。
import type { ShellPlatform } from '../tools/types'

/**
 * 宿主声明的平台。比 `ShellPlatform` 多一个 `'unsupported'`：宿主可以是 FreeBSD / AIX 这类
 * 三种 shell 都不支持的系统，它的文件能力仍然可用，只有 shell 不行。
 *
 * 少了这第四个值，这类宿主就必须在三个里挑一个谎报，随后每条命令都以一句
 * `platform mismatch` 失败——而消费方（浏览器侧的握手代码）会被迫自己发明一个回落值，
 * 那正是把权威劈成两处。这里把「没有可用 shell」做成可声明的状态，两个消费者都能如实转达。
 */
export type HostPlatform = ShellPlatform | 'unsupported'

// 宿主声明值。**只由 `configureHostInvoke` 经 declareHostPlatform 写入**，与命令桥同生共死。
let declaredPlatform: HostPlatform | undefined

/**
 * 由 `runtime/hostBridge.ts` 的 `configureHostInvoke` 独家调用：登记桥时写入宿主平台，
 * 重置桥（传 undefined）时一并清空。
 *
 * 刻意**不出现在 core 的任何公开面上**（`index.ts` / `tools/index.ts` 都不导出，
 * check-boundaries 的公开面白名单也够不到 `runtime/hostPlatform`）：一个能被单独调用的
 * setter 等于把「桥」和「平台」拆成两次登记，那就重新造出了「登记了桥但平台是上一任的」
 * 这种窗口，而它恰好是本模块整段设计要消掉的东西。
 */
export function declareHostPlatform(platform: HostPlatform | undefined): void {
  declaredPlatform = platform
}

/**
 * 本机（跑 core 的这台机器）平台探测。同步、无副作用、零依赖。
 * Tauri webview 的 UA 稳定包含 Macintosh / Windows / Linux；vitest(jsdom) 或 Node 直跑时
 * 回落到 process.platform，最后兜底 linux。
 *
 * **只有当调用方与执行命令的机器是同一台时，这个答案才等于宿主平台。** 桌面宿主属于这种情况，
 * 它在装配时用本函数的结果去声明自己的平台；远端宿主（浏览器 → Node server）必须改从握手取值，
 * 用本函数就会稳定答错。两个消费者一律读 `hostPlatform()` 而不是本函数。
 */
export function detectLocalPlatform(): ShellPlatform {
  const userAgent = typeof navigator === 'object' && typeof navigator?.userAgent === 'string'
    ? navigator.userAgent
    : ''
  if (/windows|win32|win64/i.test(userAgent)) return 'windows'
  if (/mac os|macintosh|darwin/i.test(userAgent)) return 'macos'
  if (/linux|x11|cros/i.test(userAgent)) return 'linux'
  const nodePlatform = (globalThis as { process?: { platform?: string } }).process?.platform
  if (nodePlatform === 'win32') return 'windows'
  if (nodePlatform === 'darwin') return 'macos'
  return 'linux'
}

/**
 * 当前宿主的平台——**两个消费者唯一被允许读的入口**。
 *
 * 有桥：答宿主登记桥时声明的值（远端宿主由握手取得）。没有桥：回落本地探测（见文件头）。
 * 声明值是模块私有的，除本函数外没有第二条读出通路，所以「两个消费者拿到同一个值」不是靠
 * 谁小心，是结构上取不到别的。
 */
export function hostPlatform(): HostPlatform {
  return declaredPlatform ?? detectLocalPlatform()
}
