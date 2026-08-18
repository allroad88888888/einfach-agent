// 写入目标的解析：请求路径 → 落盘用的绝对路径 + 对外展示的根相对路径
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/workspace_write_target_path.rs 整份（`resolve_workspace_path` +
// `relative_path`）。Rust 那份是**自成一体**的：它没调 workspace_common，confinement 从头到尾
// 自己写了一遍——那正是 Node 侧 common 目录开头点名的「同一条判定在六个文件里各抄一遍」之一。
// 这里不重抄，用底座里已经等价移植好的两块拼出来，并把「Rust 写入侧比读取侧多做了什么」记在下面。
//
// 【写入形态比读取形态多做的四件事，逐条对得上底座里的实现】
//   1. `trim()` + 空串检查 —— 读取侧刻意不 trim（入参清洗归命令层）；写入侧 Rust 自己 trim，
//      空串给 `path (non-empty string) is required`。→ common 的 resolveWorkspaceTargetPath 首两行。
//   2. **词法直接拒 `..`** —— 读取侧允许写 `../`，由 realpath 的结果断案；写入侧目标可能还不
//      存在，realpath 无从下手，词法层面就是唯一防线。→ hasParentSegment，文案
//      `path must not contain \`..\` components`（Rust 的 normalize_path 遇到 ParentDir 直接返回 Err）。
//   3. **最近已存在祖先** —— 目标不存在时逐级上溯到第一个存在的祖先，canonicalize 它、比边界，
//      再把缺失的那几段按字面接回去，接完**再比一次**。→ resolveExistingAncestor。
//      这一步是 symlink 逃逸的唯一防线：`<root>/link/new.txt` 里的 `link` 指向根外时，词法上它
//      稳稳在 root 下，只有把已存在的那段解成真实路径才看得出来。
//   4. **没有 allowExternalPaths** —— 读取侧有这个开关（Auto 会话读根外文件靠它），写入侧一个
//      入参都没有：读到根外只是看见，写到根外是改别人的磁盘。resolveWorkspaceTargetPath 的签名
//      里根本没有这个参数，不是默认关掉——没有开关就没有「哪天默认打开」。
//
// 【另外那半份：relative_path】
// Rust 把「绝对路径 → 根相对斜杠路径」也放在这个文件里（P2：返回给模型和聊天记录的 `path`
// 不该泄漏 /Users/... 这种本机路径）。Node 侧对应 common 的 relativeToRoot，三条边角逐条一致：
// 路径就是 root 本身 → `"."`；根外路径 → 原样返回（不是 `../..` 那种相对写法）；分隔符换正斜杠。
//
// 【它没有做、别顺手加进来的事】
// 「父目录不存在时按 createDirs 建目录」在 Rust 侧是流水线的一步，不在这里；这里只解析，不建。

import { relativeToRoot, resolveWorkspaceTargetPath } from '../common'
import type { ResolvedWriteTarget } from './types'

/**
 * 解析一个写入目标（目标可以尚不存在）。越界、含 `..`、含 NUL、空路径一律抛错，错误消息与
 * 桌面端逐字一致——调用方（流水线）负责把它转成 `ok: false` 的结构化结果。
 *
 * `requested` 收 `unknown`：路由表交给 handler 的入参是未经校验的 `Record<string, unknown>`，
 * 而这条命令走 HTTP 时载荷来自浏览器。非字符串按「没给路径」处理，用与空串同一句文案——
 * Rust 侧这种情况在 serde 反序列化时就失败了（消息不同），Node 没有那道关卡，这条兜底没有
 * Rust 对应物。
 */
export async function resolveWriteTarget(
  root: string,
  requested: unknown,
): Promise<ResolvedWriteTarget> {
  if (typeof requested !== 'string') throw new Error('path (non-empty string) is required')
  const absolutePath = await resolveWorkspaceTargetPath(root, requested)
  return { absolutePath, displayPath: relativeToRoot(root, absolutePath) }
}
