import type { Tool } from '@web-agent/core/tools'

/**
 * 占位工具登记表：`注册名 → 哪个服务的哪个占位实例占着这个名字`。
 *
 * 为什么需要它：占位工具由同步器注册，**不在** manager 的 registered 表里，可它在 ToolRegistry
 * 里实实在在占着名字。没有这本账，reconcile 只看得见「这个名字已经被别人注册了」，于是每个有
 * 缓存清单的服务一连接就抛工具名冲突（蓝图第五节的头号阻塞项）。权属判据必须来自登记，
 * **不看名字长相**——「叫 mcp__x__y」不等于「归 x 所有」。
 *
 * 这张表只记账、不碰 ToolRegistry：占位的注册与注销是同步器的事，登记只回答「这个名字算谁的」。
 * 两者必须成对：先 `registry.register(占位)` 再 `claim()`，先 `registry.unregister(name, 占位)`
 * 再 `release()`；reconcile 覆盖同名占位后同样要 `release()`，否则账实不符。
 */

export interface McpPlaceholderClaim {
  /** 占着这个名字的服务 id。 */
  readonly serverId: string
  /** 登记时注册进 ToolRegistry 的那个占位实例——一切比对都按实例，不按名字。 */
  readonly tool: Tool
}

export interface McpPlaceholderClaims {
  /**
   * 这个名字是不是**本服务**的占位占着。
   *
   * reconcile 放行同名占位的语义判据；别的服务的占位不属于本服务，仍按既有冲突处理
   * （蓝图第五节：真实工具总是覆盖【同服务】同名占位）。
   */
  owns(serverId: string, name: string): boolean
  /** 谁占着这个名字。返回占位实例，供调用方做「登记是否仍然对应 registry 当前那份注册」的比对。 */
  get(name: string): McpPlaceholderClaim | undefined
  /**
   * 登记一个占位。
   *
   * 已被**别的服务**占着 → 返回 false 且不覆盖：跨服务撞名先到先得，后者跳过
   * （调用方据此留痕，不静默）。本服务重复登记视为刷新——缓存变了会换一个占位实例，
   * 替换后返回 true。
   */
  claim(serverId: string, name: string, tool: Tool): boolean
  /**
   * 释放登记。`expected` 与 `registry.unregister` 的 expected 同源：账上仍是这个实例才删，
   * 免得旧持有者把别人新登记的同名占位误伤掉。
   */
  release(name: string, expected?: Tool): boolean
  /** 该服务当前占着的全部名字——同步器算 desired 差集用。 */
  namesFor(serverId: string): string[]
}

export function createMcpPlaceholderClaims(): McpPlaceholderClaims {
  const claims = new Map<string, McpPlaceholderClaim>()

  return {
    owns(serverId, name) {
      return claims.get(name)?.serverId === serverId
    },

    get(name) {
      return claims.get(name)
    },

    claim(serverId, name, tool) {
      const current = claims.get(name)
      if (current && current.serverId !== serverId) return false
      claims.set(name, { serverId, tool })
      return true
    },

    release(name, expected) {
      const current = claims.get(name)
      if (!current || (expected !== undefined && current.tool !== expected)) return false
      return claims.delete(name)
    },

    namesFor(serverId) {
      const names: string[] = []
      for (const [name, claim] of claims) {
        if (claim.serverId === serverId) names.push(name)
      }
      return names
    },
  }
}
