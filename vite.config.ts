/// <reference types="vitest/config" />

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createModelPreviewRelayPlugin } from './scripts/model-preview-relay'
import { assertNoPublicModelCredentials } from './scripts/public-model-credential-guard'

// 相对本配置文件解析（不再硬编码 /Volumes/... 绝对路径）——项目挪目录 / 换机器都不受影响。
const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const execFileAsync = promisify(execFile)
const TRACE_LOG_ENDPOINT = '/__web_agent_trace_logs'

type TraceDevSpanRow = {
  id?: string
  traceId?: string
  sessionId?: string | null
  runId?: string | null
  turnId?: string | null
  parentSpanId?: string | null
  name?: string
  kind?: string
  status?: string
  startedAt?: number
  endedAt?: number | null
  durationMs?: number | null
  attrs?: string | null
  error?: string | null
}

type TraceDevEventRow = {
  id?: string
  traceId?: string
  sessionId?: string | null
  runId?: string | null
  turnId?: string | null
  spanId?: string | null
  name?: string
  timestamp?: number
  attrs?: string | null
}

type TraceDevAttrs = Record<string, unknown>

function defaultTraceDbPath(): string {
  if (process.env.WEB_AGENT_TRACE_DB) return process.env.WEB_AGENT_TRACE_DB
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'com.webagent.app', 'web-agent.db')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'com.webagent.app', 'web-agent.db')
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'com.webagent.app', 'web-agent.db')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readSqliteJsonRows<T>(dbPath: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], { maxBuffer: 20 * 1024 * 1024 })
    const text = stdout.trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function parseTraceAttrs(raw: string | null | undefined): TraceDevAttrs {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as TraceDevAttrs) : {}
  } catch {
    return {}
  }
}

function putTextAttr(attrs: TraceDevAttrs, key: string, value: string | null | undefined): void {
  if (value && attrs[key] === undefined) attrs[key] = value
}

function traceAttrsWithColumns(row: TraceDevSpanRow | TraceDevEventRow): TraceDevAttrs | undefined {
  const attrs = parseTraceAttrs(row.attrs)
  putTextAttr(attrs, 'sessionId', row.sessionId)
  putTextAttr(attrs, 'runId', row.runId)
  putTextAttr(attrs, 'turnId', row.turnId)
  return Object.keys(attrs).length > 0 ? attrs : undefined
}

function traceKind(value: string | undefined): string {
  return value === 'agent' || value === 'llm' || value === 'tool' || value === 'internal' ? value : 'internal'
}

function traceStatus(value: string | undefined): string {
  return value === 'running' || value === 'ok' || value === 'error' || value === 'cancelled' ? value : 'error'
}

function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function mapTraceSpan(row: TraceDevSpanRow): Record<string, unknown> | undefined {
  if (!row.id || !row.traceId || !row.name || typeof row.startedAt !== 'number') return undefined
  return {
    id: row.id,
    traceId: row.traceId,
    parentSpanId: row.parentSpanId ?? undefined,
    name: row.name,
    kind: traceKind(row.kind),
    status: traceStatus(row.status),
    startedAt: row.startedAt,
    endedAt: optionalNumber(row.endedAt),
    durationMs: optionalNumber(row.durationMs),
    attrs: traceAttrsWithColumns(row),
    error: row.error ?? undefined,
  }
}

function mapTraceEvent(row: TraceDevEventRow): Record<string, unknown> | undefined {
  if (!row.id || !row.traceId || !row.name || typeof row.timestamp !== 'number') return undefined
  return {
    id: row.id,
    traceId: row.traceId,
    spanId: row.spanId ?? undefined,
    name: row.name,
    timestamp: row.timestamp,
    attrs: traceAttrsWithColumns(row),
  }
}

async function readDevTraceSnapshot(): Promise<Record<string, unknown>> {
  const dbPath = defaultTraceDbPath()
  if (!(await fileExists(dbPath))) {
    return { source: 'sqlite', loadedAt: Date.now(), spans: [], events: [] }
  }

  const [spanRows, eventRows] = await Promise.all([
    readSqliteJsonRows<TraceDevSpanRow>(
      dbPath,
      `SELECT id,
              trace_id AS traceId,
              session_id AS sessionId,
              run_id AS runId,
              turn_id AS turnId,
              parent_span_id AS parentSpanId,
              name,
              kind,
              status,
              started_at AS startedAt,
              ended_at AS endedAt,
              duration_ms AS durationMs,
              attrs,
              error
         FROM trace_spans
        ORDER BY started_at DESC
        LIMIT 2000`,
    ),
    readSqliteJsonRows<TraceDevEventRow>(
      dbPath,
      `SELECT id,
              trace_id AS traceId,
              session_id AS sessionId,
              run_id AS runId,
              turn_id AS turnId,
              span_id AS spanId,
              name,
              timestamp,
              attrs
         FROM trace_events
        ORDER BY timestamp DESC
        LIMIT 4000`,
    ),
  ])

  return {
    source: 'sqlite',
    loadedAt: Date.now(),
    spans: spanRows.map(mapTraceSpan).filter(Boolean),
    events: eventRows.map(mapTraceEvent).filter(Boolean),
  }
}

function traceLogDevPlugin(): Plugin {
  return {
    name: 'web-agent-trace-log-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== TRACE_LOG_ENDPOINT) {
          next()
          return
        }
        const snapshot = await readDevTraceSnapshot()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(snapshot))
      })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, fromRoot('./'), '')
  assertNoPublicModelCredentials(environment)

  return {
    root: fromRoot('./apps/web'),
    // Web 源码已迁到 apps/web；环境变量仍统一放在仓库根目录，避免 Web/Tauri 各存一份密钥。
    envDir: fromRoot('./'),
    plugins: [
      react(),
      traceLogDevPlugin(),
      ...(command === 'serve'
        ? [createModelPreviewRelayPlugin({
            deepseek: environment.DEEPSEEK_API_KEY,
            glm: environment.GLM_API_KEY,
            kimi: environment.KIMI_API_KEY,
          })]
        : []),
    ],
    build: {
      outDir: fromRoot('./apps/web/dist'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/react/')
              || id.includes('/node_modules/react-dom/')
              || id.includes('/node_modules/scheduler/')) {
              return 'react-runtime'
            }
          },
        },
      },
    },
    resolve: {
      // react/react-dom 强制解析到本 app 的 node_modules 并去重，避免多副本 React。
      alias: {
        react: fromRoot('./node_modules/react'),
        'react-dom': fromRoot('./node_modules/react-dom'),
        '@web-agent/ai': fromRoot('./packages/agent-ai/src/index.ts'),
        '@web-agent/core': fromRoot('./packages/agent-core/src'),
        // Node 宿主能力包。只被 apps/server、apps/cli 与未来的 sidecar 装配层引用，Web 产物里
        // 不该出现——留 alias 是为了 Vitest（root 是仓库根，要解析本包自己的测试）与类型一致。
        '@web-agent/host-node': fromRoot('./packages/host-node/src'),
        '@web-agent/observability-idb': fromRoot('./packages/observability-idb/src'),
        '@web-agent/observability-sqlite': fromRoot('./packages/observability-sqlite/src'),
        '@web-agent/persistence-idb': fromRoot('./packages/persistence-idb/src'),
        '@web-agent/persistence-sqlite': fromRoot('./packages/persistence-sqlite/src'),
        '@web-agent/react-plugin': fromRoot('./packages/agent-react/src/index.ts'),
        '@web-agent/subagents': fromRoot('./packages/subagents/src'),
        // 根级工具域包 + standard 聚合包：各解析到自己的 barrel。
        '@web-agent/tools-shell': fromRoot('./tools/shell/src/index.ts'),
        '@web-agent/tools-interaction': fromRoot('./tools/interaction/src/index.ts'),
        '@web-agent/tools-fs': fromRoot('./tools/fs/src/index.ts'),
        '@web-agent/tools-planning': fromRoot('./tools/planning/src/index.ts'),
        '@web-agent/tools-skills': fromRoot('./tools/skills/src/index.ts'),
        '@web-agent/tools-agents': fromRoot('./tools/agents/src/index.ts'),
        '@web-agent/tools-mcp': fromRoot('./tools/mcp/src/index.ts'),
        '@web-agent/tools': fromRoot('./tools/standard/src/index.ts'),
        '@': fromRoot('./apps/web/src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    test: {
      // Vitest 覆盖 apps、packages、tools；不要跟随 Vite 的 Web app root 缩到 apps/web。
      root: fromRoot('./'),
      environment: 'jsdom',
      setupFiles: ['./apps/web/src/test/setup.ts'],
      css: true,
      restoreMocks: true,
      // 每个测试文件在独立 worker 中运行；setup 负责同一 worker 内的默认 store 清理。
      isolate: true,
    },
  }
})
