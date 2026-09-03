// tools/shell-powershell/shell-powershell.ts —— PowerShell descriptor。
import { createShellCommandTool } from '../shellCommandTool'
import guide from './shell-powershell.md?raw'

export const shellPowershellTool = createShellCommandTool({
  name: 'shell_powershell',
  platform: 'windows',
  description: '在本机 PowerShell 中执行非交互命令。',
  triggers: ['shell', 'powershell', 'pwsh', 'terminal', 'exec', 'run command', '命令行', '终端'],
  guide,
})
