// tools/shell-macos/shell-macos.ts —— macOS shell descriptor。
import { createShellCommandTool } from '../shellCommandTool'
import guide from './shell-macos.md?raw'

export const shellMacosTool = createShellCommandTool({
  name: 'shell_macos',
  platform: 'macos',
  description: '在本机 macOS shell 中执行非交互命令。',
  triggers: ['shell', 'macos', 'terminal', 'exec', 'run command', '命令行', '终端'],
  guide,
})
