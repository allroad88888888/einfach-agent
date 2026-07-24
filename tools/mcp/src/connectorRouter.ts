import type {
  McpConnection,
  McpConnector,
  McpOperationOptions,
  McpServerConfig,
  McpTransport,
} from './types'

export type McpConnectorRoutes = Partial<Record<McpTransport, McpConnector>>

/**
 * Routes each transport to a connector. This is the composition seam used by
 * browser/desktop hosts to retain HTTP while adding a native stdio connector.
 */
export class McpConnectorRouter implements McpConnector {
  constructor(
    private readonly routes: McpConnectorRoutes,
    private readonly fallback?: McpConnector,
  ) {}

  connect(
    config: McpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpConnection> {
    const connector = this.routes[config.transport] ?? this.fallback
    if (!connector) {
      return Promise.reject(
        new Error(`No MCP connector is configured for transport: ${config.transport}`),
      )
    }
    return connector.connect(config, options)
  }
}

export function createMcpConnectorRouter(
  routes: McpConnectorRoutes,
  fallback?: McpConnector,
): McpConnector {
  return new McpConnectorRouter(routes, fallback)
}
