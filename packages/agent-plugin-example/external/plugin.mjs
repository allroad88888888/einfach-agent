// packages/agent-plugin-example/external/plugin.mjs —— docs/plugin-quickstart.md 的成品参照
// ---------------------------------------------------------------------------
// 这份文件本身不参与 pnpm workspace 构建（旁边没有 package.json）；把整个 external/ 目录
// 复制到 <workspace>/.webAgent/plugins/<任意目录名>/ 就是一个可被 CLI 加载的外部插件。
// 内容与 docs/plugin-quickstart.md 第 2/3 步逐字一致，已用 `pnpm cli -v` 实测跑通。

import { definePlugin } from '@web-agent/core/plugin'

export default definePlugin({
  install(api) {
    api.registerTool({
      name: 'hello_from_plugin',
      runtime: 'internal',
      skill: {
        description: '返回一句问候，用来验证外部插件已生效。',
        content: '# hello_from_plugin\n\n无参数，返回一条问候语，仅用于验证插件已加载并可被模型看到。',
      },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, data: { message: 'hello from acme.hello plugin' } }
      },
    })
  },
  activate(api) {
    api.observeRun((run) => {
      if (run?.status === 'running') {
        console.error('[acme.hello] run started:', run.runId)
      }
    })
  },
})
