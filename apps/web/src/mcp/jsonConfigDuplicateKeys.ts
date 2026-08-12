// MCP JSON 导入的重复键检测：一个独立的手写扫描器，不经过 JSON.parse。
//
// 【为什么单独一个文件】JSON.parse 遇到重复键时静默保留最后一个值，这对粘贴进来的 MCP
// 配置是安全隐患——攻击者可以用重复的 command/url 字段藏起真正会执行的那个。要拦住它就得
// 在标准 parse 之前自己扫一遍源文本、记录每一层对象已经出现过的键，这是一个完整独立的
// 状态机（游标 + 逐字符扫描 + 按 JSON 语法回退括号配对），和 jsonConfig.ts 里「校验一个
// 已解析对象的字段形状对不对」完全是两个层面，塞在一起会让那个文件既管扫描又管校验。

import { invalidJson, serviceLabel } from './jsonConfigErrors'

/**
 * JSON.parse silently keeps the final value when an object contains duplicate
 * keys. Reject them before parsing so a pasted MCP config cannot hide a server
 * or replace a security-relevant field.
 */
export function assertNoDuplicateObjectKeys(source: string): void {
  let cursor = 0

  const skipWhitespace = (): void => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }

  const parseString = (): string => {
    if (source[cursor] !== '"') invalidJson()
    const start = cursor
    cursor += 1
    while (cursor < source.length) {
      const char = source[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '"') {
        cursor += 1
        try {
          return JSON.parse(source.slice(start, cursor)) as string
        } catch {
          invalidJson()
        }
      }
      cursor += 1
    }
    invalidJson()
  }

  const duplicateKeyError = (path: readonly string[], key: string): never => {
    if (path.length === 1 && path[0] === 'mcpServers') {
      throw new Error(`MCP 服务名称重复：“${key}”`)
    }
    if (path.length >= 2 && path[0] === 'mcpServers') {
      throw new Error(`${serviceLabel(path[1] ?? '')}存在重复字段“${key}”`)
    }
    throw new Error(`MCP JSON 对象存在重复字段“${key}”`)
  }

  const parseValue = (path: readonly string[]): void => {
    skipWhitespace()
    const char = source[cursor]
    if (char === '{') {
      cursor += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (source[cursor] === '}') {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        skipWhitespace()
        const key = parseString()
        if (keys.has(key)) duplicateKeyError(path, key)
        keys.add(key)
        skipWhitespace()
        if (source[cursor] !== ':') invalidJson()
        cursor += 1
        parseValue([...path, key])
        skipWhitespace()
        if (source[cursor] === '}') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalidJson()
        cursor += 1
      }
      invalidJson()
    }
    if (char === '[') {
      cursor += 1
      skipWhitespace()
      if (source[cursor] === ']') {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        parseValue(path)
        skipWhitespace()
        if (source[cursor] === ']') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalidJson()
        cursor += 1
      }
      invalidJson()
    }
    if (char === '"') {
      parseString()
      return
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    )
    if (!primitive) invalidJson()
    cursor += primitive[0].length
  }

  parseValue([])
  skipWhitespace()
  if (cursor !== source.length) invalidJson()
}
