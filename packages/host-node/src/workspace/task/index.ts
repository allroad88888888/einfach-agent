// workspace/task 域的 registrar：`run_workspace_task`
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/workspace_task.rs（已随 T1 删除；预置任务：按 kind 发现并跑构建/测试/lint 命令，
// 与自由 shell 分开——不接受任意命令行）。域内分层：
//   taskKind.ts                 ← 合法 kind、解析、kind → package.json script 名
//   packageManager.ts           ← 包管理器探测（lockfile 优先，退回 package.json 字段，再退 npm）
//   resolveTask.ts               ← kind → 具体要跑的命令行（TaskSpec）
//   taskProcess.ts               ← 起子进程、带超时地等它退出、超时杀进程（含进程组）
//   readWorkspaceTaskOutput.ts   ← 并发读 stdout/stderr（两路都是 drain 语义，理由见该文件）
//   runWorkspaceTaskHandler.ts   ← 入参收窄 + 顶层编排 + handler 工厂

import { createRunWorkspaceTaskHandler } from './runWorkspaceTaskHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createTaskRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    run_workspace_task: createRunWorkspaceTaskHandler(options),
  }
}
