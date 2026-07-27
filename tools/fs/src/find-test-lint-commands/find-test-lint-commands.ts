import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import type {
  ListWorkspaceFilesResult,
  ReadWorkspaceFileResult,
  WorkspaceRuntimeResult,
} from '@web-agent/core/runtime/workspaceRead'
import guide from './find-test-lint-commands.md?raw'

const MAX_ENTRIES = 2_000
const MAX_MANIFESTS = 16
const MAX_BYTES_PER_MANIFEST = 8_000
const MAX_OUTPUT_TOKENS = 1_200

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'noxfile.py',
  'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'gradlew', 'gradlew.bat',
  'composer.json', 'gemfile', 'rakefile', 'makefile', 'justfile',
  'cmakelists.txt', 'meson.build', 'conanfile.txt', 'conanfile.py',
  'build.sbt', 'package.swift', 'pubspec.yaml', 'mix.exs', 'rebar.config',
  'project.clj', 'deps.edn', 'stack.yaml', 'cabal.project', 'nimble.lock',
  'deno.json', 'deno.jsonc', 'bunfig.toml', 'workspace', 'workspace.bazel',
])

const IGNORED_PATH_SEGMENTS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', '.next', '.venv', 'venv',
])

type MaybeWorkspaceResult<T> = WorkspaceRuntimeResult<T> | T

interface WorkspaceDiscoveryContext extends ToolContext {
  listWorkspaceFiles(input: {
    path?: string
    recursive?: boolean
    maxEntries?: number
    includeHidden?: boolean
  }): Promise<MaybeWorkspaceResult<ListWorkspaceFilesResult>>
  readWorkspaceFile(input: {
    path: string
    maxBytes?: number
    offset?: number
  }): Promise<MaybeWorkspaceResult<ReadWorkspaceFileResult>>
}

type CommandKind = 'test' | 'lint'
type CommandOrigin = 'declared' | 'inferred'
type Confidence = 'high' | 'medium' | 'low'

interface VerificationCommand {
  kind: CommandKind
  argv: string[]
  cwd: string
  origin: CommandOrigin
  evidence: string
  confidence: Confidence
}

const EXTRACTION_SYSTEM_PROMPT = `You extract repository test and lint command candidates from configuration files.
You receive only a JSON array of configuration-file excerpts; there is no conversation or source-code context.
Return ONLY strict JSON matching this schema:
{"commands":[{"kind":"test|lint","argv":["program","arg"],"cwd":"relative/path/or-dot","origin":"declared|inferred","evidence":"file path and exact config basis","confidence":"high|medium|low"}],"warnings":["string"]}

Rules:
1. Extract only test or lint commands. argv is an argument vector, never a shell string and never includes shell operators, redirects, substitutions, environment assignments, pipes, or chaining.
2. Prefer explicit project scripts/tasks. Use origin="declared" only when the config explicitly declares that command or task.
3. You may emit origin="inferred" only for a standard command conclusively supported by a recognized project manifest; state that basis in evidence and never invent package names, paths, flags, or custom tasks.
4. If uncertain, omit the command and add a warning. Do not claim commands ran, succeeded, or are safe.
5. Use each manifest's directory as cwd. Deduplicate equivalent commands. Keep at most 32 commands and 16 warnings.`

function isStructuredResult<T>(value: MaybeWorkspaceResult<T>): value is WorkspaceRuntimeResult<T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
}

function unwrap<T>(value: MaybeWorkspaceResult<T>): T {
  if (!isStructuredResult(value)) return value
  if (value.ok) return value.data
  throw new Error(value.error)
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isCandidateManifest(path: string): boolean {
  const normalized = normalizedPath(path)
  const segments = normalized.toLowerCase().split('/')
  if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) return false
  const name = segments.at(-1)
  if (!name) return false
  return MANIFEST_NAMES.has(name)
    || name.endsWith('.sln')
    || name.endsWith('.csproj')
    || name.endsWith('.fsproj')
    || name.endsWith('.vbproj')
    || name.endsWith('.cabal')
    || name.endsWith('.rockspec')
}

function cwdFor(path: string): string {
  const normalized = normalizedPath(path)
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? '.' : normalized.slice(0, slash) || '.'
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!candidate) return undefined
  try {
    return asRecord(JSON.parse(candidate))
  } catch {
    return undefined
  }
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000\r\n]/.test(text)) return undefined
  return text
}

function cleanArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) return undefined
  const argv = value.map((item) => cleanText(item, 240))
  if (argv.some((item) => !item) || argv.some((item) => /(?:&&|\|\||[|;<>`$]|\$\(|\$\{)/.test(item!))) return undefined
  return argv as string[]
}

function cleanCwd(value: unknown): string | undefined {
  const cwd = cleanText(value, 400)
  if (!cwd || cwd.startsWith('/') || cwd.split('/').includes('..')) return undefined
  return cwd === '.' ? cwd : normalizedPath(cwd)
}

function normalizeExtraction(text: string, allowedCwds: ReadonlySet<string>): { commands: VerificationCommand[]; warnings: string[] } | undefined {
  const object = parseJsonObject(text)
  if (!object || !Array.isArray(object.commands)) return undefined
  const warnings = Array.isArray(object.warnings)
    ? object.warnings.map((warning) => cleanText(warning, 500)).filter((warning): warning is string => Boolean(warning)).slice(0, 16)
    : []
  const seen = new Set<string>()
  const commands: VerificationCommand[] = []
  for (const rawCommand of object.commands) {
    const command = asRecord(rawCommand)
    const kind = command.kind === 'test' || command.kind === 'lint' ? command.kind : undefined
    const argv = cleanArgv(command.argv)
    const cwd = cleanCwd(command.cwd)
    const origin = command.origin === 'declared' || command.origin === 'inferred' ? command.origin : undefined
    const evidence = cleanText(command.evidence, 600)
    const confidence = command.confidence === 'high' || command.confidence === 'medium' || command.confidence === 'low'
      ? command.confidence
      : undefined
    if (!kind || !argv || !cwd || !origin || !evidence || !confidence || !allowedCwds.has(cwd)) continue
    const key = `${kind}\u0000${cwd}\u0000${argv.join('\u0000')}`
    if (seen.has(key)) continue
    seen.add(key)
    commands.push({ kind, argv, cwd, origin, evidence, confidence })
    if (commands.length === 32) break
  }
  return { commands, warnings }
}

export const findTestLintCommandsTool: Tool = {
  name: 'find_test_lint_commands',
  execution: { mode: 'parallel', effectKeys: ['workspace:read'] },
  runtime: 'server',
  skill: {
    description: '用低成本、无对话上下文的模型从项目配置中提取 test/lint 命令候选；不会执行命令。',
    triggers: ['find test command', 'find lint command', '测试命令', 'lint 命令'],
    content: guide,
  },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const discovery = ctx as Partial<WorkspaceDiscoveryContext>
    if (typeof discovery.listWorkspaceFiles !== 'function' || typeof discovery.readWorkspaceFile !== 'function') {
      return {
        ok: false,
        error: 'find_test_lint_commands is unavailable: workspace read APIs are not configured',
        code: 'COMMAND_DISCOVERY_UNAVAILABLE',
        retryable: false,
      }
    }
    if (typeof ctx.runLowCostExtraction !== 'function') {
      return {
        ok: false,
        error: 'find_test_lint_commands is unavailable: low-cost extraction is not configured',
        code: 'COMMAND_DISCOVERY_MODEL_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      ctx.progress('识别项目 test/lint 命令')
      const listing = unwrap(await discovery.listWorkspaceFiles.call(ctx, {
        path: '.', recursive: true, maxEntries: MAX_ENTRIES, includeHidden: false,
      }))
      const paths = listing.entries
        .filter((entry) => entry.type === 'file' && isCandidateManifest(entry.path))
        .map((entry) => normalizedPath(entry.path))
        .sort()
        .slice(0, MAX_MANIFESTS)
      const warnings: string[] = []
      if (listing.truncated) warnings.push(`workspace file listing was truncated at ${MAX_ENTRIES} entries`)
      if (paths.length === 0) {
        return { ok: true, data: { model: undefined, manifests: [], commands: [], warnings } }
      }

      const manifests: Array<{ path: string; cwd: string; content: string; truncated: boolean }> = []
      for (const path of paths) {
        try {
          const file = unwrap(await discovery.readWorkspaceFile.call(ctx, {
            path, maxBytes: MAX_BYTES_PER_MANIFEST, offset: 0,
          }))
          manifests.push({ path, cwd: cwdFor(path), content: file.content, truncated: file.truncated })
          if (file.truncated) warnings.push(`${path} was truncated at ${MAX_BYTES_PER_MANIFEST} bytes`)
        } catch (error) {
          warnings.push(`could not read ${path}: ${errorMessage(error)}`)
        }
      }
      if (manifests.length === 0) {
        return { ok: true, data: { model: undefined, manifests: paths, commands: [], warnings } }
      }

      const extraction = await ctx.runLowCostExtraction({
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        userPrompt: JSON.stringify({ manifests }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      })
      const result = normalizeExtraction(extraction.content, new Set(manifests.map((manifest) => manifest.cwd)))
      if (!result) {
        return {
          ok: false,
          error: 'find_test_lint_commands received invalid JSON from the extraction model',
          code: 'COMMAND_DISCOVERY_INVALID_MODEL_OUTPUT',
          retryable: true,
        }
      }
      return {
        ok: true,
        data: {
          model: extraction.model,
          manifests: manifests.map(({ path, cwd, truncated }) => ({ path, cwd, truncated })),
          commands: result.commands,
          warnings: [...warnings, ...result.warnings].slice(0, 32),
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: `find_test_lint_commands failed: ${errorMessage(error)}`,
        code: 'COMMAND_DISCOVERY_FAILED',
        retryable: true,
      }
    }
  },
}
