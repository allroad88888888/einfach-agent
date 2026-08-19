// 收窄外部 JSON 时共用的形状判据
// ---------------------------------------------------------------------------
// 本域有三处要把「一袋外部输入」收窄成一个确定的形状：信封、target、body。三处的判据必须一致，
// 否则同一份可疑输入会在一处被拒、在另一处被收。
//
// ═══ `definedKeys`：为什么不是 `Object.keys` ═══
// serde 的 `deny_unknown_fields` 在 Rust 侧看到的是 **JSON 文本**，那里根本没有 `undefined`。
// Node 这一层不一样：同一张路由表既挂在 HTTP 后面（载荷经 `JSON.parse`，无 undefined），也被
// CLI / sidecar 进程内直接注入（对象字面量原样到达，可选项常常是「键存在且为 undefined」）。
// 拿裸 `Object.keys` 判「有没有多余字段」，同一份入参在两种传输下会得到不同答案——本地能跑、
// 上 server 就变，或者反过来。
//
// 这**不削弱** deny_unknown_fields：JSON 表达不出 undefined，所以攻击者塞进来的多余键必然带值，
// 照样落在下面的判定里。

/** JSON 对象（不含数组与 null）。 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有值的键。值为 `undefined` 的键当作没写——理由见文件头。 */
export function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined)
}

/** `deny_unknown_fields` 的等价物：有值的键集合必须**恰好**是这一组。 */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = definedKeys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
