// `get_user_home_dir` 的 Node 实现
// ---------------------------------------------------------------------------
// N 线第一条落地的命令，同时是「一条命令怎么写」的样板：一个文件一条命令，导出一个
// **接受装配槽、返回 handler** 的工厂。工厂而不是裸函数，是因为 handler 的行为要能被
// `createNodeHostInvoke(options)` 的槽位影响，而槽位只在装配时拿得到。
//
// 为什么这条命令是「主目录是什么」的唯一权威：core 的 runtime/userSkillsRoot.ts 拿到这个值
// 之后，会把它当作**同一次桥调用**的 confinement 根传回来读文件
// （`workspace_root: <home>` + `allow_external_paths: true`）。桥背后是哪台机器，主目录就得是
// 哪台机器的——浏览器接 Node 后端时，前端自己根本不知道该指哪里。所以本卡明确拒绝把主目录
// 塞进 `/api/health` 之类的握手响应：那会让同一个事实有两个来源，而两者漂移时的症状只是
// 「用户级 skills 扫不到」，不报错、也不指向病因。
//
// 解析逻辑本身住 homeDirectory.ts：`~/.webAgent/config.json` 的路径解析要用同一个值，
// 而「同一个事实两处各算一遍」正是上一段拒绝的那件事。

import { resolveHomeDirectory } from './homeDirectory'
import type { NodeHostInvokeOptions } from '../hostOptions'

export function createUserHomeDirHandler(options: NodeHostInvokeOptions) {
  return async (): Promise<string> => resolveHomeDirectory(options)
}
