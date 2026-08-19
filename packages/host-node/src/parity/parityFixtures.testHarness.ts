// 对拍 fixture 的加载与比对口径
// ---------------------------------------------------------------------------
// `packages/host-node/fixtures/` 里的 JSON 由 TS 与 Rust 两侧各自的驱动器读取，跑同一组用例。
// 本文件是 TS 侧的加载入口与**比对口径**；schema、分组与「新增一组要改哪几个文件」在
// ../../fixtures/README.md。
//
// ═══ 为什么比对的是结构而不是字符串 ═══
// `apps/desktop/Cargo.toml`（已随 T1 删除）的 `serde_json` 没开 `preserve_order`，`Value::Object` 底层是
// `BTreeMap`，重新序列化时字段按 key 字节序**重排**；JS 的 `JSON.parse` → `JSON.stringify`
// 保留插入序。两边逐字符比字符串必然假红，所以两侧都比**解析后的结构**——键顺序不算差异。
//
// ═══ 但键的有无必须算差异，所以要先过一遍 JSON ═══
// Rust 的 `skip_serializing_if = "Option::is_none"` 会让那个键整个消失（`changeSummary`、
// `diff`），而没有该属性的 `Option` 序列化成显式 `null`（`changeSet`、`error`）。TS 侧的可选
// 属性在内存里是「键不存在」或「键存在但值为 undefined」，两者在 `toEqual` 眼里都等于 `{}`
// ——直接比内存对象会让「本该是 null 却写成了 undefined」这种分岔静默通过。先
// `JSON.parse(JSON.stringify(...))`：`undefined` 的键在这一步消失，与 serde 的 skip 对齐，
// 再用 `toStrictEqual` 比，缺一个 `null` 当场红。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * fixture 目录。相对本文件定位，仓库挪位置不受影响。
 *
 * **不要写成 `new URL('../../fixtures/', import.meta.url)`**：Vite 认得这个字面量组合，会把它当
 * 「静态资源 URL」重写掉，于是运行时拿到的是 `http://localhost:3000/packages/host-node/fixtures`
 * ——路径部分是对的，scheme 变成了 http，`fileURLToPath` 当场抛「The URL must be of scheme file」。
 * 先把 `import.meta.url` 解成路径、再用 `path.resolve` 拼，就绕开了那条重写规则。
 */
const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

/** 每份 fixture 的顶层形状：`target` 是给人看的一句话，`cases` 才是驱动器要跑的。 */
export interface ParityFixture<Case> {
  target: string
  cases: Case[]
}

/**
 * 读一份 fixture。**同步读**：驱动器要在 `describe` 的顶层按用例展开成一串 `it`，异步加载
 * 就只能塞进一个 `it` 里循环——那样一条分岔会把整组染红，看不出是哪一例。
 */
export function loadParityFixture<Case>(fileName: string): ParityFixture<Case> {
  const raw = readFileSync(join(fixturesDirectory, fileName), 'utf8')
  const parsed = JSON.parse(raw) as ParityFixture<Case>
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`fixture ${fileName} 里没有可跑的用例`)
  }
  return parsed
}

/**
 * 把被测结果压成「与 fixture 可比」的纯数据：`undefined` 的键消失，`Map` / `class` 之类的东西
 * 一律不许出现在这条路上（它们会被 `JSON.stringify` 变成 `{}`，那是静默的）。
 */
export function toComparableJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 跑一步纯规则并把结果规约成「状态」或「错误文案」。
 *
 * 错误比的是 `message` **全等**而不是 `toThrow` 的子串匹配：两个宿主对同一次拒绝必须说同一句
 * 完整的话，子串匹配会让「Node 在文案后面多缀了半句」这种分岔溜过去。
 */
export function captureFailure(run: () => void): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
