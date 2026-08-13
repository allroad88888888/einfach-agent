import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { ProjectSkillsLoaderBridge } from '@web-agent/core/runtime/core/coreInstance'

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
  const startInfo = await lstat(start)
  if (!startInfo.isDirectory() || startInfo.isSymbolicLink()) {
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
      if (info.isSymbolicLink()) continue
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
