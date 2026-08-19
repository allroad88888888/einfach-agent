import { definePlugin, type Plugin, type PluginRunSnapshot, type Tool } from '@einfach-agent/core/plugin'

export const LIFECYCLE_PROBE_TOOL_NAME = 'lifecycle_probe'

export interface LifecycleProbePluginOptions {
  /** Requests a safe stop when this plugin observes its run starting. */
  readonly stopOnRunStart?: boolean
  /** Exercises the host error boundary after a completed tool call. */
  readonly throwAfterToolCall?: boolean
  /** Exposes projected run events to an embedding test or application. */
  readonly onRunEvent?: (event: PluginRunSnapshot | undefined) => void
  /** Runs once when the host disposes this run activation. */
  readonly onDispose?: () => void
}

function createProbeTool(): Tool {
  return {
    name: LIFECYCLE_PROBE_TOOL_NAME,
    runtime: 'internal',
    skill: {
      description: 'Reports that the lifecycle plugin tool is available.',
      content: '# Lifecycle probe\n\nUse this tool to verify that the lifecycle sample plugin is installed.',
    },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true, data: { plugin: 'lifecycle-probe' } }),
  }
}

function isRunning(event: PluginRunSnapshot | undefined): boolean {
  return event?.status === 'running'
}

/** Creates a non-React plugin that demonstrates the public lifecycle API. */
export function createLifecycleProbePlugin(
  options: LifecycleProbePluginOptions = {},
): Plugin {
  return definePlugin({
    install(api) {
      api.registerTool(createProbeTool())
    },
    activate(api) {
      api.observeRun((event) => {
        options.onRunEvent?.(event)
        if (options.stopOnRunStart && isRunning(event)) api.commands.stopCurrentRun()
      })
      api.onAfterToolCall(() => {
        if (options.throwAfterToolCall) throw new Error('lifecycle probe after-tool-call failure')
      })
      return () => options.onDispose?.()
    },
  })
}
