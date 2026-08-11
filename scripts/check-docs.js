#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirectories = new Set([
  '.webAgent-cache',
  '.webAgent-archive',
  '.codegraph',
  '.git',
  '.claude',
  '.webAgent',
  'dist',
  'node_modules',
  'research',
  'target',
])
const legacyPathExemptions = new Set([
  'docs/core-plugin-extraction-blueprint.md',
  'docs/structure-optimization-blueprint.md',
])
const inlineLinkPattern = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g
const referenceLinkPattern = /^\s*\[[^\]]+]:\s*(?:<([^>]+)>|(\S+))/gm
const legacySourcePathPattern = /(^|[^A-Za-z0-9_./-])src\/agentNew(?:\/|$)/g
const urlSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** Lists Markdown documentation while excluding generated and mirrored source trees. */
async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await markdownFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path)
    }
  }
  return files
}

function relativeFilePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}

function lineNumber(text, position) {
  return text.slice(0, position).split('\n').length
}

function linkTargets(text) {
  const targets = []
  for (const pattern of [inlineLinkPattern, referenceLinkPattern]) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      targets.push({ value: match[1] ?? match[2], position: match.index })
    }
  }
  return targets
}

function isRelativeLink(target) {
  return target.length > 0
    && !target.startsWith('#')
    && !target.startsWith('/')
    && !target.startsWith('//')
    && !urlSchemePattern.test(target)
}

function targetPath(target) {
  const path = target.split(/[?#]/, 1)[0]
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function isWithinRepository(path) {
  const pathFromRoot = relative(repositoryRoot, path)
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith('../')
}

async function missingRelativeLinks(path, text) {
  const errors = []
  for (const link of linkTargets(text)) {
    if (!isRelativeLink(link.value)) continue
    const destination = targetPath(link.value)
    if (!destination) continue
    const resolved = resolve(dirname(path), destination)
    if (!isWithinRepository(resolved) || !(await stat(resolved).catch(() => undefined))) {
      errors.push(`${relativeFilePath(path)}:${lineNumber(text, link.position)} broken relative link: ${link.value}`)
    }
  }
  return errors
}

function legacyPathReferences(path, text) {
  if (legacyPathExemptions.has(relativeFilePath(path))) return []
  const errors = []
  legacySourcePathPattern.lastIndex = 0
  for (let match = legacySourcePathPattern.exec(text); match; match = legacySourcePathPattern.exec(text)) {
    const position = match.index + match[1].length
    errors.push(`${relativeFilePath(path)}:${lineNumber(text, position)} old source path: src/agentNew/`)
  }
  return errors
}

async function main() {
  const files = (await markdownFiles(repositoryRoot)).sort()
  const errors = []
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    errors.push(...await missingRelativeLinks(path, text), ...legacyPathReferences(path, text))
  }
  if (errors.length > 0) {
    console.error('Documentation check failed:')
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`Documentation check passed (${files.length} Markdown files).`)
}

main().catch((error) => {
  console.error(`Documentation check failed: ${error.message}`)
  process.exitCode = 1
})
