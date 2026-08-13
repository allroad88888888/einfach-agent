import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const execFileAsync = promisify(execFile)
const cli = resolve(process.cwd(), 'scripts/check-boundaries.js')

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'boundary-check-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

function run(root) {
  return execFileAsync(process.execPath, [cli, '--root', root])
}

test('违规 import 会失败并报告文件、行号与规则名', async () => {
  const root = await fixture({
    'packages/agent-core/src/core.ts': "import React from 'react'\nexport { tool } from '@web-agent/tools-mcp'\n",
    'packages/subagents/src/runner.ts': "const load = () => import('@web-agent/tools')\n",
  })
  await assert.rejects(run(root), (error) => {
    assert.match(error.stderr, /packages\/agent-core\/src\/core.ts:1 core 禁入 React/)
    assert.match(error.stderr, /packages\/agent-core\/src\/core.ts:2 core 禁入工具域/)
    assert.match(error.stderr, /packages\/subagents\/src\/runner.ts:1 能力包禁入工具域/)
    return true
  })
})

test('合法 import 与完整注释行会通过', async () => {
  const root = await fixture({
    'packages/agent-core/src/core.ts': "// import React from 'react'\nimport { invoke } from '@tauri-apps/api/core'\n",
    'packages/persistence-idb/src/store.ts': "export { record } from '@web-agent/core'\n",
  })
  const result = await run(root)
  assert.match(result.stdout, /边界检查通过（扫描 2 个非测试 TS\/TSX 文件，生效 5 条规则）。/)
})
