// 把 unknown 异常转成一行消息文本
// ---------------------------------------------------------------------------
// Rust 侧每个失败点都写成 `format!("... : {err}")`，靠的是 `io::Error` 一定有 Display。
// TS 的 catch 参数是 `unknown`，直接模板字符串插值会把非 Error 值印成 `[object Object]`，
// 于是本该指向病因的那半句话变成噪音。收成一处，免得 20 处 catch 各写各的。

/** 取异常的可读文本：Error 用 `message`，其余原样 String 化。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
