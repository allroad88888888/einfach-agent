import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

it('wraps injected bundles so repeated classic-script evaluation cannot overwrite prior module state', () => {
  const config = readFileSync(join(process.cwd(), 'browser-agent/extension/tsup.config.ts'), 'utf8')
  expect(config).toContain("banner: { js: '(() => {' }")
  expect(config).toContain("footer: { js: '})();' }")
  expect(config).toContain('splitting: false')
})
