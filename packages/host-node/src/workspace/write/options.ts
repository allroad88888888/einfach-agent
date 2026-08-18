// 把字符串入参解析成写入选项（模式与编码）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_options.rs 的 `parse_mode` / `parse_encoding`。
// 同文件里的 `normalize_max_bytes` 在 Node 侧归 W5 的 limitChecks.ts——那是「按限额做的判定」，
// 与这里「把一个自由字符串收成闭合取值」不是一件事。
//
// 【为什么不用 TS 的联合类型直接收】
// 这两个参数在 Rust 侧的类型是 `Option<String>` 而不是闭合 enum，**故意的**：模型传来一个
// 拼错的模式时，要给它一句说得出出路的错误（`expected create, overwrite, upsert, or append`），
// 而不是让 serde 用一句反序列化失败把整次调用打回去。Node 侧同理，收 `string | undefined`。
//
// 缺省值各不相同，别顺手统一：模式默认 `create`（写一个已存在的文件必须是明确的意图），
// 编码默认 `utf8`。

import { rejectWrite } from './result'
import type { ContentEncoding, WriteMode } from './types'

/** 解析写入模式。非法值按设计拒绝（`WriteRejection`），文案与 Rust 逐字一致。 */
export function parseMode(mode: string | undefined): WriteMode {
  switch (mode ?? 'create') {
    case 'create':
      return 'create'
    case 'overwrite':
      return 'overwrite'
    case 'append':
      return 'append'
    case 'upsert':
      return 'upsert'
    default:
      return rejectWrite(
        `invalid mode \`${mode}\`; expected \`create\`, \`overwrite\`, \`upsert\`, or \`append\``,
      )
  }
}

/** 解析 content 的载法。`utf-8` 与 `utf8` 同义（Rust 侧两个字面量都收）。 */
export function parseEncoding(encoding: string | undefined): ContentEncoding {
  switch (encoding ?? 'utf8') {
    case 'utf8':
    case 'utf-8':
      return 'utf8'
    case 'base64':
      return 'base64'
    default:
      return rejectWrite(`invalid encoding \`${encoding}\`; expected \`utf8\` or \`base64\``)
  }
}
