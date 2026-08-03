// 子代理运行时身份兼容转接。

/** Reads the currently configured provider identity as a provider-neutral runtime value. */
export function runtimeModelIdentity(config: { deepseekUserId?: string }): string | undefined {
  return config.deepseekUserId
}

/** Converts the generic root model identity into the current child-runtime option shape. */
export function delegateModelIdentity(userId?: string): Record<string, string> {
  return userId === undefined ? {} : { deepseekUserId: userId }
}
