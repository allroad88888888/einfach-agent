// S4-B 危险工具集判定 —— 哪些 server 工具在执行前需要用户确认。
// ---------------------------------------------------------------------------
// 「危险」= 任意本机执行或直接变更磁盘的 server 工具：本机 shell（macos/linux/powershell）、
// 写文件、打补丁。只读工具不在内 —— 不需确认。
//
// run_task 有执行项目脚本的风险，但它不是任意 shell：只接受固定 kind，后端固定 argv、workspace、
// timeout 和输出上限。这里刻意不纳入确认集，保留「改代码 → 跑验证」的最小闭环。
// 单点定义，供 modelRun tool 循环在「分发工具前」判定是否暂停等确认（镜像 ask_user 暂停）。

// 危险（变更类）server 工具名集合。新增变更类工具时在这里补一行即可。
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  'shell_macos',
  'shell_linux',
  'shell_powershell',
  'write_file',
  'apply_patch',
])

// 简介：某工具名是否属于「执行前需用户确认」的危险工具集。
export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name)
}
