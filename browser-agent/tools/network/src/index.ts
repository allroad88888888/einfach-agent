import type { Tool, ToolRegistry } from '@einfach-agent/core/tools'
import { createGetNetworkRequestTool } from './get-network-request/get-network-request'
import { createGetNetworkResponseTool } from './get-network-response/get-network-response'
import { createListNetworkRequestsTool } from './list-network-requests/list-network-requests'
import { createStartNetworkCaptureTool } from './start-network-capture/start-network-capture'
import { createStopNetworkCaptureTool } from './stop-network-capture/stop-network-capture'
import { createWaitForNetworkRequestTool } from './wait-for-network-request/wait-for-network-request'
import type { NetworkToolsHost } from './types'

export * from './types'
export { NetworkToolsError, type NetworkErrorCode } from './network-error'
export { createWindowNetworkHost } from './window-host'
export { installWindowNetworkRecorder } from './window-recorder'
export { createStartNetworkCaptureTool } from './start-network-capture/start-network-capture'
export { createStopNetworkCaptureTool } from './stop-network-capture/stop-network-capture'
export { createListNetworkRequestsTool } from './list-network-requests/list-network-requests'
export { createGetNetworkRequestTool } from './get-network-request/get-network-request'
export { createGetNetworkResponseTool } from './get-network-response/get-network-response'
export { createWaitForNetworkRequestTool } from './wait-for-network-request/wait-for-network-request'

export function createNetworkTools(host: NetworkToolsHost): readonly Tool[] {
  return [createStartNetworkCaptureTool(host), createListNetworkRequestsTool(host), createGetNetworkRequestTool(host), createGetNetworkResponseTool(host), createWaitForNetworkRequestTool(host), createStopNetworkCaptureTool(host)]
}
export function registerNetworkTools(registry: ToolRegistry, host: NetworkToolsHost): void { for (const tool of createNetworkTools(host)) registry.register(tool) }
