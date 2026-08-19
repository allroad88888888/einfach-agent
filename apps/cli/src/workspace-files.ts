import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { ProjectSkillsLoaderBridge } from '@einfach-agent/core'

interface FileEntry {
  path: string
  type: string
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

/** Resolves a workspace-relative path and rejects every lexical escape. */
export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(root, requestedPath)
  if (!isWithinRoot(root, target)) throw new Error('路径超出工作区边界。')
  return target
}

function relativePath(workspaceRoot: string, target: string): string {
  return relative(resolve(workspaceRoot), target).split(sep).join('/')
}

async function listWorkspaceFiles(
  path: string,
  options: Parameters<ProjectSkillsLoaderBridge['listFiles']>[1],
): Promise<{ entries: FileEntry[] }> {
  const root = resolve(options.workspaceRoot)
  const start = resolveWorkspacePath(root, path)
  // 起点用 stat（跟随链接）：loader 会把「被链接进 .claude/skills 的 skill 目录」当独立根再扫
  // 一次，那时起点本身就是一个符号链接。桌面端 Rust 侧同样接受这种根（canonicalize 后即目标），
  // 两个宿主的扫描语义必须一致——否则同一台机器上 CLI 比桌面少几个 skill，且没人说得清为什么。
  const startInfo = await stat(start)
  if (!startInfo.isDirectory()) {
    throw new Error(`路径不可访问：${path}`)
  }

  const entries: FileEntry[] = []
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      if (entries.length >= options.maxEntries) return
      if (!options.includeHidden && child.name.startsWith('.')) continue
      const directoryPath = relativePath(root, directory)
      const childPath = directoryPath ? `${directoryPath}/${child.name}` : child.name
      const target = resolveWorkspacePath(root, childPath)
      const info = await lstat(target)
      // 符号链接**列出但不跟进**（与桌面端一致）：跟进等于把根外的树整片拉进来，而列出让
      // loader 有机会把它当独立根单独扫——被链接的 skill 因此可见，其余文件仍在各自根内。
      if (info.isSymbolicLink()) {
        entries.push({ path: relativePath(root, target), type: 'symlink' })
        continue
      }
      if (info.isDirectory()) {
        entries.push({ path: relativePath(root, target), type: 'directory' })
        if (options.recursive) await visit(target)
      } else if (info.isFile()) {
        entries.push({ path: relativePath(root, target), type: 'file' })
      }
    }
  }

  await visit(start)
  return { entries }
}

async function readWorkspaceFile(
  path: string,
  options: Parameters<ProjectSkillsLoaderBridge['readFile']>[1],
): Promise<{ content: string }> {
  const target = resolveWorkspacePath(options.workspaceRoot, path)
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`路径不可读取：${path}`)
  const content = (await readFile(target)).subarray(0, options.maxBytes).toString('utf8')
  return { content }
}

/** Builds the Node filesystem bridge used by the project-skills loader. */
export function buildNodeProjectSkillsBridge(): ProjectSkillsLoaderBridge {
  return {
    listFiles: listWorkspaceFiles,
    readFile: readWorkspaceFile,
  }
}

/** Validates the selected workspace before core tools receive its path. */
export async function resolveWorkspaceRoot(input: string): Promise<string> {
  const root = resolve(input)
  if (!(await stat(root)).isDirectory()) throw new Error(`工作区不是目录：${root}`)
  return root
}
