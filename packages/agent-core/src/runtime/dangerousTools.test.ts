import { describe, expect, it } from 'vitest'
import { classifyToolRisk } from './dangerousTools'

describe('classifyToolRisk', () => {
  it.each([
    'rm -rf *',
    'sudo rm -r -f /',
    'cd /tmp && rm -Rf "./*"',
    'rm -rf $HOME',
    'rm -rf "$PWD"',
  ])('把大范围递归强删判为 critical：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command }).level).toBe('critical')
  })

  it('把删除 workspace 根目录或其父目录判为 critical', () => {
    expect(classifyToolRisk(
      'shell_linux',
      { command: 'rm -rf /Volumes/work/ai' },
      { workspaceRoot: '/Volumes/work/ai/web-agent' },
    ).level).toBe('critical')
  })

  it.each([
    'pwd',
    'pnpm test',
    'rm -rf ./dist',
  ])('普通 shell 仍为 dangerous：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command }).level).toBe('dangerous')
  })

  it.each([
    'rm note.txt',
    'sudo rm -f build.log',
    'cd tmp && rm -r cache',
    '/bin/rm generated.txt',
    'env rm generated.txt',
    "sh -c 'rm generated.txt'",
  ])('普通命令行 rm 标记不可撤回，但不强制打断 Auto：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command })).toMatchObject({
      level: 'dangerous',
      irreversible: true,
    })
    expect(classifyToolRisk('shell_macos', { command }).requiresConfirmation).toBeUndefined()
  })

  it('可恢复 delete_path 是普通 dangerous，Auto 可直接执行', () => {
    expect(classifyToolRisk('delete_path', { path: 'build', recursive: true })).toEqual({
      level: 'dangerous',
    })
  })

  it('外部 MCP 工具即使在 Auto 模式也必须逐次确认', () => {
    expect(classifyToolRisk('mcp__github__create_issue', { title: 'test' })).toEqual({
      level: 'dangerous',
      reason: '该操作由外部 MCP 服务执行，调用前需要确认将发送的参数',
      requiresConfirmation: true,
    })
  })

  it('直接覆写设备判为 critical，非变更工具为 safe', () => {
    expect(classifyToolRisk('shell_linux', { command: 'dd if=/dev/zero of=/dev/sda' }).level).toBe('critical')
    expect(classifyToolRisk('read_file', { path: '/tmp/a' }).level).toBe('safe')
  })

  it('PowerShell 宽范围递归强删判为 critical', () => {
    expect(classifyToolRisk(
      'shell_powershell',
      { command: 'Remove-Item -Recurse -Force *' },
    ).level).toBe('critical')
  })
})
