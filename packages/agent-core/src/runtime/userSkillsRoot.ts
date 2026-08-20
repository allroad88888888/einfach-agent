// runtime/userSkillsRoot.ts —— 用户级 skills 的扫描根（主目录）解析
// ---------------------------------------------------------------------------
// 工作区级 skills 的根由会话自带；用户级的那份要问宿主要主目录。这个值走宿主桥的
// get_user_home_dir 命令，理由是它随后会被 tools/skills/src/projectSkillsLoader.ts 当作同一次
// 桥调用的 confinement 根（`workspaceRoot: root.root` + `allowExternalPaths: true`）传回去——
// 主目录必须和文件读取问的是同一台机器，桥背后是哪台机器它就是哪台的（浏览器接 Node 后端时，
// 前端本身并不知道"主目录"该指哪里）。没有登记桥的宿主（纯浏览器、还没装配桥的环境）→
// undefined，扫描方据此只扫工作区。CLI 宿主不走这里：它有 node:os，自己在装配层传 homedir()。
//
// 拿不到主目录一律降级成 undefined 而非抛出：用户级 skills 是增益，主目录解析失败不该让
// 整个项目 skills 扫描（进而稳定前缀里的 L1 清单）跟着失败。

import { hasHostBridge, loadHostInvoke } from './hostBridge'

/** 去掉结尾斜杠（保留根 `/`）：三个宿主各自的 get_user_home_dir 实现返回值带不带尾斜杠不保证
 *  一致，而这个值会被当成路径拼接的根与快照里的展示值，两种写法会让缓存键与 UI 文案随宿主漂移。
 *  归一化因此只留 core 这一份，不指望三个宿主实现各自对齐。 */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

/**
 * 解析用户级 skills 的扫描根。
 *
 * 返回 undefined = 本宿主没有主目录可扫（未登记桥的宿主），不是错误。
 */
export async function resolveUserSkillsRoot(): Promise<string | undefined> {
  if (!hasHostBridge()) return undefined

  try {
    const invoke = await loadHostInvoke()
    const homeDir = await invoke<string>('get_user_home_dir')
    // invoke<T> 的类型实参只是编译期承诺、不做运行时校验：显式判 typeof 是字符串再 trim。
    if (typeof homeDir !== 'string') return undefined
    const home = homeDir.trim()
    return home ? stripTrailingSlash(home) : undefined
  } catch {
    return undefined
  }
}
