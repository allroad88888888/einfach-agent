// shell 域的 registrar：`run_shell_command`
// ---------------------------------------------------------------------------
// 形状与 config 域一致（`create<Domain>Routes(options) => NodeHostRouteTable`）。本域只有
// 一条命令，但它背后是七个文件——分法直接照搬 Rust 侧的模块划分（去掉 `shell_` 前缀就是
// 这里的文件名），一处一处对得上：
//
//   runShellCommand.ts ← shell.rs         命令入口：收窄线上入参
//   pipeline.ts        ← shell_pipeline.rs 主流程：准备 → 起进程 → 等待 → 收尾
//   platform.ts        ← shell_platform.rs 平台校验、shell 选择、cwd 解析
//   spawn.ts           ← shell_spawn.rs    起子进程（进程组、env、管道）
//   wait.ts            ← shell_wait.rs     等退出 / 超时杀进程组
//   outputCapture.ts   ← shell_output.rs   一条管道的带上限捕获
//   drain.ts           ← shell_drain.rs    子进程退出后回收（或放弃）读端
//   types.ts           ← shell_types.rs    常量、结果载荷、shell 规格
//   deadline.ts        ← 无对应物（Rust 靠轮询判到点，Node 靠与定时器竞速）
//
// 【本域没有跨调用的状态】
// 一次调用 = 一个子进程，`executeShellCommand` 返回前它一定已经退出或被杀。所以这里没有
// 进程表、没有句柄登记、没有 `hostOptions` 槽位——Rust 侧同样没有（`shell_wait.rs` 只是
// 「等这一个直接子进程」，不是「登记一个后台进程供后续轮询」）。
//
// 唯一会活过一次调用的是**真正 daemon 化的孙进程**（自己关掉了继承来的 fd）：管道见到
// EOF，宿主既看不见它也不该替它做主，这与桌面端今天的行为一致。没 daemon 化却还握着管道
// 的孙进程会在 drain 阶段连同整个进程组被杀掉，并以 `background_processes_killed: true`
// 明确告诉调用方「`cmd &` 起的东西没活下来」。
//
// 于是「宿主关闭时怎么处理还活着的后台进程」这个问题在本域退化成：没有需要处理的东西。
// 唯一的例外是宿主在某次调用**进行中**被杀——子进程在自己的进程组里，收不到终端的 Ctrl-C，
// 会继续跑到自己结束（Rust 的 `process_group(0)` 行为完全相同）。要改这一点得有一张跨调用
// 的在跑进程表，那是新设计、不是移植，本卡不做。

import { createRunShellCommandHandler } from './runShellCommand'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'

/** `options` 目前用不上：本域的全部输入都在命令入参里，没有需要宿主注入的本机事实。 */
export function createShellRoutes(_options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    run_shell_command: createRunShellCommandHandler(),
  }
}
