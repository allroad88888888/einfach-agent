// tools/shell-linux/shell-linux.ts —— Linux shell descriptor。
import { createShellCommandTool } from '../shellCommandTool'
import guide from './shell-linux.md?raw'

export const shellLinuxTool = createShellCommandTool({
  name: 'shell_linux',
  platform: 'linux',
  description: '在本机 Linux shell 中执行非交互命令。',
  triggers: ['shell', 'linux', 'terminal', 'exec', 'run command', '命令行', '终端'],
  guide,
})
