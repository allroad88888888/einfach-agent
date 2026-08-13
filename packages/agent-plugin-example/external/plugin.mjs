// packages/agent-plugin-example/external/plugin.mjs —— docs/plugin-quickstart.md 的成品参照
// ---------------------------------------------------------------------------
// 这份文件本身不参与 pnpm workspace 构建（旁边没有 package.json）；把整个 external/ 目录
// 复制到 <workspace>/.webAgent/plugins/<任意目录名>/ 就是一个可被 CLI 与桌面加载的外部插件。
// 内容与 docs/plugin-quickstart.md 第 2/3 步逐字一致，已用 `pnpm cli -v` 实测跑通。
//
// 下面这行【静态】import 是两个宿主都认的唯一形态：CLI 经 node_modules 解析，桌面由宿主在求值前
// 改写成契约模块桥的 URL（apps/web/src/plugins/contractImportRewrite.ts）。改成 await import(...)
// 会在桌面上被直接拒绝。

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
