import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { inspectWebSource } from './webCapabilityStaticAnalysis.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const webSourceRoot = path.join(repositoryRoot, 'apps/web/src')
const desktopSourceRoot = path.join(repositoryRoot, 'apps/desktop/src')
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return /\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name) ? [entryPath] : []
  }))
  return files.flat()
}

function isProductionWebSource(file) {
  const relative = path.relative(webSourceRoot, file)
  return !relative.split(path.sep).includes('test')
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
}

function rustCharEnd(text, index) {
  const content = text[index] === "'" ? index + 1
    : text[index] === 'b' && text[index + 1] === "'" ? index + 2 : -1
  if (content === -1 || content >= text.length) return undefined
  let delimiter
  if (text[content] === '\\') {
    if (text[content + 1] === 'u' && text[content + 2] === '{') {
      const brace = text.indexOf('}', content + 3)
      if (brace === -1) return undefined
      delimiter = brace + 1
    } else delimiter = content + (text[content + 1] === 'x' ? 4 : 2)
  } else delimiter = content + ([...text.slice(content)][0]?.length ?? 0)
  return text[delimiter] === "'" ? delimiter + 1 : undefined
}

function rustCode(text) {
  let code = ''
  let index = 0
  while (index < text.length) {
    if (text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index + 2)
      index = newline === -1 ? text.length : newline
      continue
    }
    if (text.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < text.length && depth > 0) {
        if (text.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (text.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      continue
    }
    const characterEnd = rustCharEnd(text, index)
    if (characterEnd !== undefined) {
      index = characterEnd
      code += "''"
      continue
    }
    const raw = /^(?:br|cr|r)(#*)"/.exec(text.slice(index))
    if (raw) {
      const close = `"${raw[1]}`
      const end = text.indexOf(close, index + raw[0].length)
      index = end === -1 ? text.length : end + close.length
      code += '""'
      continue
    }
    const quoteOffset = text[index] === '"' ? 0 : /[bc]/.test(text[index]) && text[index + 1] === '"' ? 1 : -1
    if (quoteOffset !== -1) {
      index += quoteOffset + 1
      while (index < text.length) {
        if (text[index] === '\\') index += 2
        else if (text[index++] === '"') break
      }
      code += '""'
      continue
    }
    code += text[index]
    index += 1
  }
  return code
}

function withoutRustTestModules(code) {
  const testModule = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+\w+\s*\{/g
  let match
  while ((match = testModule.exec(code))) {
    let cursor = testModule.lastIndex, depth = 1
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === '{') depth += 1
      else if (code[cursor] === '}') depth -= 1
      cursor += 1
    }
    code = code.slice(0, match.index) + code.slice(cursor)
    testModule.lastIndex = match.index
  }
  return code
}
function inspectRustSource(text) {
  const code = withoutRustTestModules(rustCode(text))
  const violations = []
  if (/\#\s*\[\s*tauri::command\b/.test(code)) violations.push('declares tauri command')
  if (/\binvoke_handler\s*[!(]/.test(code)) violations.push('installs invoke handler')
  if (/\b(?:print|println|eprint|eprintln|dbg|panic|panic_any)\b/.test(code)) violations.push('uses output macro')
  if (/\b(?:stdout|stderr|OpenOptions|File|Emitter|log|tracing|write|write_all)\b|\.emit(?:_to)?\s*\(/.test(code)) {
    violations.push('uses a log, disk, or event sink')
  }
  return { code, violations }
}

test('production Web source structurally excludes Tauri and child-process capabilities', async () => {
  const files = (await sourceFiles(webSourceRoot)).filter(isProductionWebSource)
  const violations = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const finding of inspectWebSource(file, text, webSourceRoot)) {
      violations.push(`${path.relative(repositoryRoot, file)}: ${finding}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('Web guard rejects static, dynamic, require, bracket, and alias evasions', () => {
  const evasions = [
    `import '@tauri-apps/api/core'`,
    `export { invoke } from '@tauri-apps/api/core'`,
    `import('@tauri-apps/' + 'api/core')`,
    `const pkg = '@tauri-apps/api/core'; import(pkg)`,
    "const scope = 'api'; import(`@tauri-apps/${scope}/core`)",
    `require('@tauri-apps/api/core')`,
    `require('node:child_process')`,
    `import('child_process')`,
    `const { invoke: call } = window.__TAURI__.core; call('x')`,
    `const call = window['__TAURI__'].core['invoke']; call('x')`,
    `window['__' + 'TAURI__'].core.invoke('x')`,
    `const key = '__' + 'TAURI__'; window[key].core.invoke('x')`,
    `window[(('__' + 'TAURI__'))].core.invoke('x')`,
    `const key = ('__' + 'TAURI__') as const; window[key].core.invoke('x')`,
    `window[<string>('__' + 'TAURI__')].core.invoke('x')`,
    `window[(('__' + 'TAURI__') satisfies string)].core.invoke('x')`,
    `const load = require; load(source)`,
    `const load = globalThis['requ' + 'ire']; load('node:child_process')`,
    `const key = ('requ' + 'ire') as const; const load = globalThis[key]; load(source)`,
    `const { [('requ' + 'ire') as string]: load } = globalThis; load(source)`,
    `const load = (source) => import(source); load(specifier)`,
  ]
  for (const [index, source] of evasions.entries()) {
    assert.notDeepEqual(inspectWebSource(`evasion-${index}.ts`, source, webSourceRoot), [], `evasion ${index} passed`)
  }

  const pluginEntry = path.join(webSourceRoot, 'plugins/pluginImportModule.ts')
  const trusted = `const evaluate = options.evaluate ?? ((url: string) => import(url) as Promise<unknown>)`
  assert.deepEqual(inspectWebSource(pluginEntry, trusted, webSourceRoot), [])
  const unboundPluginImports = [
    `const url = attackerControlled; const evaluate = () => import(url)`,
    `const evaluate = (url: string) => import(otherUrl)`,
    `const evaluate = (url: string) => { const nested = () => import(url); return nested() }`,
  ]
  for (const [index, source] of unboundPluginImports.entries()) {
    assert.notDeepEqual(
      inspectWebSource(pluginEntry, source, webSourceRoot),
      [],
      `unbound plugin import ${index} passed`,
    )
  }
})

test('Web guard only folds immutable lexical const bindings', () => {
  const bindingEvasions = [
    `let target = './safe.js'; target = attackerControlled; import(target)`,
    `let key = 'safe'; key = 'require'; const load = globalThis[key]; load(source)`,
    `const target = './safe.js'; { const target = attackerControlled; import(target) }`,
    `const key = 'safe'; { const key = 'require'; const load = globalThis[key]; load(source) }`,
    `import(target); const target = './safe.js'`,
    `const target = './safe.js'; target++; import(target)`,
    `const target = './safe.js'; ({slot: {target}} = attackerControlled); import(target)`,
    `const target = './safe.js'; [[target]] = attackerControlled; import(target)`,
    `const target = './safe.js'; for (target of attackerControlled) {} import(target)`,
    `const target = './safe.js'; for (target in attackerControlled) {} import(target)`,
    `const key = 'safe'; ({slot: [key]} = attackerControlled); globalThis[key](source)`,
    `const key = 'safe'; ({slot: {key}} = attackerControlled); globalThis[key](source)`,
    `const key = 'safe'; [[key]] = attackerControlled; globalThis[key](source)`,
    `const key = 'safe'; for (key of attackerControlled) {} globalThis[key](source)`,
    `const key = 'safe'; for (key in attackerControlled) {} globalThis[key](source)`,
  ]
  for (const [index, source] of bindingEvasions.entries()) {
    assert.notDeepEqual(
      inspectWebSource(`binding-evasion-${index}.ts`, source, webSourceRoot),
      [],
      `binding evasion ${index} passed`,
    )
  }

  const provenConstants = [
    `const prefix = './'; const target = prefix + 'safe.js'; import(target)`,
    "const name = 'safe'; import(`./${name}.js`)",
    `const key = 'safe'; globalThis[key]`,
  ]
  for (const [index, source] of provenConstants.entries()) {
    assert.deepEqual(inspectWebSource(`proven-constant-${index}.ts`, source, webSourceRoot), [])
  }
})

test('desktop Rust is output-free and ready errors cannot capture data', async () => {
  const files = (await sourceFiles(desktopSourceRoot)).filter((file) => file.endsWith('.rs'))
  const violations = []
  let sidecarCode = ''
  for (const file of files) {
    const inspected = inspectRustSource(await readFile(file, 'utf8'))
    if (file.endsWith('server_sidecar.rs')) sidecarCode = inspected.code
    for (const finding of inspected.violations) {
      violations.push(`${path.relative(repositoryRoot, file)}: ${finding}`)
    }
  }

  const errorBody = /enum\s+SidecarError\s*\{([^}]*)\}/.exec(sidecarCode)?.[1]
  assert.ok(errorBody, 'SidecarError enum is missing')
  const variants = errorBody.replace(/\#\s*\[[^\]]*\]/g, '').split(',').map((part) => part.trim()).filter(Boolean)
  assert.ok(
    variants.length > 0 && variants.every((variant) => /^[A-Za-z_]\w*$/.test(variant)),
    'SidecarError variants must remain fieldless',
  )
  assert.deepEqual(violations, [])

  const lexerFixture = `let marker = r#"//"#; /* outer /* nested */ */ #[tauri::command] fn leak() {}`
  const aliasFixture = `use std::println as leak; leak!("{}", ready.url);`
  const charFixture = `let quote = '"'; let byte = b'"'; #[tauri::command] fn leak() {}`
  const panicFixture = `use std::panic::panic_any as fail; fail(token);`
  assert.ok(inspectRustSource(lexerFixture).violations.includes('declares tauri command'))
  assert.ok(inspectRustSource(aliasFixture).violations.includes('uses output macro'))
  assert.ok(inspectRustSource(charFixture).violations.includes('declares tauri command'))
  assert.ok(inspectRustSource(panicFixture).violations.includes('uses output macro'))
})
