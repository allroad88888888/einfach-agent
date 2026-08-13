import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it as test } from 'vitest'
// vitest 全量套件会扫描 scripts/*.test.js，故与兄弟脚本测试一致用 vitest 断言面。
const assert = {
  equal: (a, b, msg) => expect(a, msg).toBe(b),
  match: (a, re, msg) => expect(a, msg).toMatch(re),
  doesNotMatch: (a, re, msg) => expect(a, msg).not.toMatch(re),
  ok: (v, msg) => expect(v, msg).toBeTruthy(),
  rejects: async (promise, validate) => {
    let rejected = false
    try {
      await promise
    } catch (error) {
      rejected = true
      if (validate) expect(validate(error)).not.toBe(false)
    }
    expect(rejected, '期望 Promise 被拒绝').toBe(true)
  },
}

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
  assert.match(result.stdout, /边界检查通过（扫描 2 个非测试 TS\/TSX 文件，生效 6 条规则）。/)
  assert.doesNotMatch(result.stdout, /core 厂商名红线/)
})

test('厂商名字面量在非豁免 core 文件命中会失败', async () => {
  const root = await fixture({
    'packages/agent-core/src/runtime/foo.ts': "export const vendor = 'deepseek'\n",
  })
  await assert.rejects(run(root), (error) => {
    assert.match(error.stderr, /边界检查失败：/)
    assert.match(error.stderr, /packages\/agent-core\/src\/runtime\/foo\.ts:1 core 厂商名红线（deepseek）/)
    return true
  })
})

test('厂商名字面量在豁免 core 文件命中只报观察项、不会失败', async () => {
  const root = await fixture({
    'packages/agent-core/src/state/persistence/modelMigration.ts': "export const vendor = 'deepseek'\n",
  })
  const result = await run(root)
  assert.match(result.stdout, /边界观察项：/)
  assert.ok(
    result.stdout.includes(
      'packages/agent-core/src/state/persistence/modelMigration.ts:1 观察项：core 厂商名红线（deepseek）—— 豁免原因：历史迁移必须认识旧厂商模型名',
    ),
    result.stdout,
  )
  assert.match(result.stdout, /边界检查通过/)
})

test('core 文件不含厂商名字面量时厂商名红线无观察项也不失败', async () => {
  const root = await fixture({
    'packages/agent-core/src/runtime/foo.ts': "export const vendor: string = readVendorFromConfig()\n",
  })
  const result = await run(root)
  assert.match(result.stdout, /边界检查通过/)
  assert.doesNotMatch(result.stdout, /core 厂商名红线/)
})

test('厂商名 snake_case 内嵌（下划线两侧，无其他命中位置）在非豁免 core 文件命中会失败', async () => {
  // 全行唯一的 "deepseek" 出现在下划线两侧，旧 \b 正则会把 "_" 当单词字符从而漏判；
  // 这条 fixture 里刻意不放任何被引号 / 非字母数字包围的厂商名，专门用来卡这一漏洞。
  const root = await fixture({
    'packages/agent-core/src/runtime/foo.ts': "const non_deepseek_provider = true\n",
  })
  await assert.rejects(run(root), (error) => {
    assert.match(error.stderr, /边界检查失败：/)
    assert.match(error.stderr, /packages\/agent-core\/src\/runtime\/foo\.ts:1 core 厂商名红线（deepseek）/)
    return true
  })
})

test('厂商名 snake_case 内嵌在豁免 core 文件命中只报观察项、不会失败', async () => {
  const root = await fixture({
    'packages/agent-core/src/state/persistence/modelMigration.ts': "const legacy_deepseek_vendor_map = true\n",
  })
  const result = await run(root)
  assert.match(result.stdout, /边界观察项：/)
  assert.ok(
    result.stdout.includes(
      'packages/agent-core/src/state/persistence/modelMigration.ts:1 观察项：core 厂商名红线（deepseek）—— 豁免原因：历史迁移必须认识旧厂商模型名',
    ),
    result.stdout,
  )
  assert.match(result.stdout, /边界检查通过/)
})
