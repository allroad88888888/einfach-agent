// 生成稳定唯一 id；crypto 不可用的环境退回时间戳+随机后缀。
// ---------------------------------------------------------------------------
// 关键：必须先 `typeof crypto !== 'undefined'` 守卫。`crypto.randomUUID?.()` 只防
// 属性为空、不防 `crypto` 全局本身未声明 —— 后者会直接抛 ReferenceError。
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
