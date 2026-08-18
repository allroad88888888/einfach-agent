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

import { homedir } from 'node:os'
import type { NodeHostInvokeOptions } from '../hostOptions'

/** 去掉结尾斜杠（保留根 `/`）。口径与 core 的 runtime/userSkillsRoot.ts 一致。 */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

/**
 * 解析主目录。
 *
 * 抛错而不是返回空串：`os.homedir()` 在极少数环境（无 HOME、无 passwd 条目）下会给出空值，
 * 而空串一旦被当成路径根用下去，后续拼接全部指向文件系统根且不会报错。调用方
 * （runtime/userSkillsRoot.ts）自己就把异常降级成「本宿主没有主目录可扫」，所以在这里明确
 * 失败没有任何副作用，反而保住了病因。
 */
export function createUserHomeDirHandler(options: NodeHostInvokeOptions) {
  return async (): Promise<string> => {
    const configured = options.homeDir?.trim()
    const resolved = stripTrailingSlash(configured || homedir().trim())
    if (!resolved) throw new Error('Node 宿主无法定位用户主目录（os.homedir() 返回空值）')
    return resolved
  }
}
