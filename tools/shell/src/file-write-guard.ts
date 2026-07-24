export interface ShellFileWriteDetection {
  reason: string
}

const DIRECT_WRITE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsed\b[\s\S]*?(?:^|\s)-i(?:\s|[.'"]|$)/i, reason: 'sed in-place edit' },
  { pattern: /\bperl\b[\s\S]*?(?:^|\s)-(?:\w*i\w*|i)(?:\s|$)/i, reason: 'perl in-place edit' },
  { pattern: /\btruncate\b/i, reason: 'direct file-content writing command' },
  {
    pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/i,
    reason: 'scripted filesystem write',
  },
  {
    pattern: /\b(?:write_text|write_bytes)\s*\(/i,
    reason: 'scripted filesystem write',
  },
]

const PYTHON_COMMAND_PATTERN = /\bpython(?:\d+(?:\.\d+)*)?\b/i
const PYTHON_WRITE_PATTERN =
  /\bopen\s*\([\s\S]*?,\s*['"][^'"]*[wax+][^'"]*['"]|(?:^|[^.\w])(?:write|writelines)\s*\(/i

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function isNonFileOutputTarget(rawTarget: string): boolean {
  const target = unquote(rawTarget.trim())
  return /^(?:-|\/dev\/(?:null|stdout|stderr|fd\/\d+)|\/proc\/self\/fd\/\d+|NUL|\$null)$/i.test(
    target,
  )
}

function hasFileOutputRedirection(command: string): boolean {
  // Ignore descriptor wiring such as 2>&1 and here-doc/string input (<< / <<<).
  const withoutDescriptorRedirects = command.replace(/\b\d*>\s*&\s*\d+\b/g, '')
  const redirects =
    withoutDescriptorRedirects.matchAll(
      /(^|[\s;&|])(?:\d*)>{1,2}(?![>&])\s*("[^"]*"|'[^']*'|[^\s&|]+)/gm,
    )
  return [...redirects].some((match) => !isNonFileOutputTarget(match[2]))
}

function hasTeeFileTarget(command: string): boolean {
  const invocations = command.matchAll(/\btee\b([^|;&\n]*)/gi)
  for (const invocation of invocations) {
    const args = [...invocation[1].matchAll(/"[^"]*"|'[^']*'|[^\s]+/g)].map(
      (match) => match[0],
    )
    const targets = args.filter((arg) => arg !== '--' && !arg.startsWith('-'))
    if (targets.some((target) => !isNonFileOutputTarget(target))) return true
  }
  return false
}

function hasPowerShellFileContentWrite(command: string): boolean {
  const invocations = command.matchAll(
    /\b(Set-Content|Add-Content|Clear-Content|Out-File)\b([^|;\r\n]*)/gi,
  )
  for (const invocation of invocations) {
    const tool = invocation[1].toLowerCase()
    const args = invocation[2]
    const namedTarget = args.match(
      /-(?:LiteralPath|Path|FilePath)\s+("[^"]*"|'[^']*'|[^\s]+)/i,
    )?.[1]
    const positionalTarget = args.trim().match(/^("[^"]*"|'[^']*'|[^\s]+)/)?.[1]
    const target = namedTarget ?? positionalTarget
    if (!target) continue
    if (isNonFileOutputTarget(target)) continue

    // Content cmdlets can also write PowerShell providers such as Env: and
    // Registry:. Those are not file-content edits and remain available.
    if (
      tool !== 'out-file' &&
      /^(?:Env|Variable|Alias|Function|Registry|Certificate|Cert|HKCU|HKLM):/i.test(
        unquote(target),
      )
    ) {
      continue
    }
    return true
  }
  return false
}

/**
 * Direct file-content writes must go through workspace-aware tools so they are
 * validated and reversible. Other filesystem operations remain available.
 */
export function detectShellFileWrite(command: string): ShellFileWriteDetection | undefined {
  for (const candidate of DIRECT_WRITE_PATTERNS) {
    if (candidate.pattern.test(command)) {
      return { reason: candidate.reason }
    }
  }

  if (PYTHON_COMMAND_PATTERN.test(command) && PYTHON_WRITE_PATTERN.test(command)) {
    return { reason: 'Python script writes files' }
  }

  if (hasTeeFileTarget(command)) {
    return { reason: 'tee writes a regular file' }
  }

  if (hasPowerShellFileContentWrite(command)) {
    return { reason: 'PowerShell command writes file contents' }
  }

  if (hasFileOutputRedirection(command)) {
    return { reason: 'shell output redirection writes a file' }
  }

  return undefined
}

export function shellFileWriteRejected(toolName: string, detection: ShellFileWriteDetection) {
  return {
    ok: false as const,
    code: 'shell_file_write_rejected',
    error: `${toolName} rejected: detected file modification via shell (${detection.reason})`,
    hint: 'Use write_file for text file writes, or apply_patch for targeted edits to existing files. Shell commands must not write file contents directly.',
  }
}
