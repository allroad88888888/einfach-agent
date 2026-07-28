// 本机平台探测（同步、无副作用、零依赖）。
// ---------------------------------------------------------------------------
// Tauri webview 的 UA 稳定包含 Macintosh / Windows / Linux；vitest(jsdom) 或 Node 直跑时
// 回落到 process.platform，最后兜底 linux。
// ★ 为什么收口成一处 ★ —— 这个值有两个消费者，且必须逐字一致：
//   · shell 桥要求调用方传 platform，Rust 侧会拒绝与宿主不符的值；
//   · 注入给模型的「运行环境」段也要报同一个平台。
//   两边各写一份探测逻辑，任何一次改动都可能让「告诉模型的平台」与「实际执行的平台」漂移，
//   于是模型按 A 平台组命令、桥按 B 平台拒绝。故本函数是唯一真相源，tools-* 也从这里导入。
import type { ShellPlatform } from '../tools/types'

export function detectHostPlatform(): ShellPlatform {
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
