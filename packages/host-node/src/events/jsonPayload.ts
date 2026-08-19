// 事件载荷的类型约束：JSON 值，且**进程内那条路也照此收紧**
// ---------------------------------------------------------------------------
// 【问题】事件面要同时容下三种传输：
//
//   CLI      —— 进程内直接回调，载荷**原样**交给 handler，不序列化
//   浏览器    —— apps/server 的 SSE（C3），载荷经 `JSON.stringify` → `JSON.parse` 往返一次
//   Tauri 套壳 —— sidecar，同样要跨进程序列化
//
// 若载荷允许任意对象，这三条路就会给出**不同的值**，而分岔只在其中一条上现形：
//
//   | 写进载荷的东西        | CLI 进程内 handler 看到 | 过一次 JSON 后 handler 看到 |
//   | -------------------- | --------------------- | ------------------------- |
//   | `undefined`          | `undefined`           | **键整个消失**              |
//   | 函数 / Symbol 值      | 函数 / Symbol          | **键整个消失**              |
//   | `Date`               | `Date` 实例            | ISO 字符串（`toJSON` 干的） |
//   | `Map` / `Set`        | 原对象                 | `{}`（空对象，内容全丢）     |
//   | `NaN` / `Infinity`   | `NaN` / `Infinity`     | `null`                    |
//   | `-0`                 | `-0`                  | `+0`                      |
//   | `BigInt`             | bigint                | **`JSON.stringify` 抛异常** |
//   | 循环引用              | 正常                   | **`JSON.stringify` 抛异常** |
//   | Symbol 键的属性       | 在                     | **静默丢掉**                |
//   | `Object.create(null)` | 无原型（没有 `hasOwnProperty`）| 普通对象（有）      |
//   | 稀疏数组 / 挂了属性的数组 | 原样                | 空洞变 `null`、额外属性消失   |
//
// 这就是「本地能跑、过了 SSE 变形」：CLI 上写测试全绿，浏览器上收到的 `startedAt` 是字符串、
// `message` 那个键干脆不存在。而且它不报错——handler 拿着 `undefined` 继续跑。
//
// 【裁决】载荷的类型约束 = **JSON 值**，顶层必须是普通对象（record）。两层落实：
//
//   1. **编译期**：`hostEventPayloads.ts` 的载荷映射 `extends Record<HostEventName, JsonRecord>`。
//      往载荷里写一个 `Date` 字段，那一行当场编译失败。
//   2. **运行期**：`assertJsonEventPayload` 在**每次 emit 时**走一遍载荷。
//
// 【为什么运行期这一遍不能省，尤其不能只在 dev 开】
// 编译期只管**声明的**形状。真正流进来的值来自 MCP 传输层（C1）读子进程的输出，那一路上
// 类型断言、`JSON.parse` 出来的 `any`、外部输入都可能把非 JSON 值塞进一个声明为 JSON 的位置。
// 而关键在于：**只有让进程内那条路也执行 JSON 的约束，三种传输才是同一个契约**。
// 若这一遍只在 dev 跑，生产 CLI 就会接受一个生产 SSE 会改写的值——分岔原封不动地回来了。
// 校验代价：载荷是两三个字符串字段，一次遍历，相对 spawn 一个子进程可以忽略。
// **它换来的是「CLI 这条路不付序列化的代价，但付序列化的约束」**——判据里说的「无需序列化」
// 是不该白白复制一份数据，不是说契约可以只考虑进程内。
//
// 【明确不在契约内的两件事：对象身份与可变性】
// 进程内 handler 拿到的是发射方那个对象本身；SSE 那头每个客户端各 `JSON.parse` 出一份新的。
// 所以**身份不可依赖**（`payload === 上一次的 payload`、载荷里两个字段指向同一对象），
// **载荷不可改写**（进程内改了后一个 handler 会看见，过了线上改了谁也看不见）。
// 不在 emit 时深冻结来强制这一条，理由是权属：那个对象是发射方的，冻结是往别人的数据上留
// 副作用；而声明的载荷类型每个字段都是 `readonly`（连 `JsonValue` 的索引签名也是），
// 在仓库内改写它本来就是类型错误。运行期冻结只能多抓住「已经 `as` 掉类型的人」，
// 不值得拿「发射方复用对象会突然抛异常」去换。
//
// 顺带一条不算分岔的：同一个子对象被载荷引用两次（菱形，不是环）**是允许的**——JSON 会把它
// 展开成两份内容相同的副本，结构上仍然相等，只有身份变了，而身份本来就不在契约内。
// 所以下面的 `seen` 是一条**路径栈**（进递归加、出递归删），只认环，不误伤菱形。
//
// 已知未覆盖的一处：载荷里挂 getter 且每次读返回不同值时，本判据读到的、进程内 handler 读到的、
// 序列化时读到的可能是三个值。没有为它加描述符检查——`readonly` 的载荷类型里写不出 getter，
// 要绕过得先 `as` 掉类型，而那一步已经在契约之外了。撞上时症状是「值对不上」而非静默变形。

/** JSON 能原样表达的标量。注意 `undefined` 不在其中——它是被 `JSON.stringify` 丢掉的那个。 */
export type JsonPrimitive = string | number | boolean | null

/** JSON 值。递归定义，数组与对象都收敛到只读形态。 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonRecord

/**
 * JSON 对象。事件载荷的顶层必须是它，而不是数组或标量：
 * 一帧 SSE 的 `data:` 携带一份 JSON 文档，record 形态才留得下「以后往载荷里加一个字段」的余地，
 * 换成数组或标量时任何扩展都是破坏性变更。现有两个载荷本来也都是 record。
 */
export interface JsonRecord {
  readonly [key: string]: JsonValue
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  // 只认 `Object.prototype`。`Date` / `Map` / `Set` / 各种 class 实例都被这一条挡下——它们过 JSON
  // 后要么变形（Date → 字符串）要么清空（Map / Set → `{}`）。
  // **null 原型也不放行**：`Object.create(null)` 能被 `JSON.stringify` 正常序列化，但解回来的是
  // 一个带 `Object.prototype` 的普通对象。于是进程内 handler 手里的东西没有 `hasOwnProperty`、
  // `'toString' in it` 为假，过了 SSE 的那份两条都反过来——这就是分岔，不是身份差异。
  // 已知边界：跨 realm（`node:vm`、worker）造出来的普通对象原型不是本 realm 的 `Object.prototype`,
  // 会被判为非普通对象。本包的载荷都在本进程里就地构造，不受影响；真撞上时报错是响亮的。
  return Object.getPrototypeOf(value) === Object.prototype
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value !== 'object') return withArticle(typeof value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype === null) return 'a null-prototype object'
  const name = (prototype as { constructor?: { name?: unknown } } | null)?.constructor?.name
  return typeof name === 'string' && name.length > 0
    ? withArticle(name)
    : 'an object with a non-plain prototype'
}

function findSymbolKeys(value: object, path: string): string | undefined {
  return Object.getOwnPropertySymbols(value).length > 0
    ? `${path} has symbol-keyed properties; JSON.stringify drops them silently.`
    : undefined
}

/**
 * 找出第一个过不了 JSON 的值，返回一句**指得出位置**的说明；全都过得了则返回 `undefined`。
 *
 * 为什么是「结构遍历」而不是「`JSON.parse(JSON.stringify(x))` 再深比一次」：后者判的是**症状**
 * （值变了），报不出**病因**（哪个字段、为什么）。遍历能说「payload.startedAt is a Date;
 * JSON.stringify rewrites it as a string.」，那句话直接指向要改的代码。
 * 至于「这套规则是否真的等于 JSON 的行为」，靠 `jsonPayload.test.ts` 里那组等价性测试钉住：
 * 每个被拒的值都断言它确实过不了 JSON 往返，每个被放行的值都断言它确实原样往返。
 */
function findNonJsonValue(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (value === null) return undefined
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined
    case 'number':
      if (!Number.isFinite(value)) {
        return `${path} is ${String(value)}; JSON.stringify rewrites it as null.`
      }
      // 负零：`JSON.stringify(-0)` 写成 `"0"`，解回来是 `+0`。进程内那份还是 `-0`，
      // `Object.is` / `1 / x` 两侧不同。值本身几乎不会在载荷里出现，拦下它的意义是让
      // 「本判据 == JSON 的保真行为」这句话是**真的**，而不是「基本上是真的」。
      return Object.is(value, -0)
        ? `${path} is -0; JSON.stringify rewrites it as 0.`
        : undefined
    case 'undefined':
      return `${path} is undefined; JSON.stringify drops the key entirely.`
    case 'function':
      return `${path} is a function; JSON.stringify drops the key entirely.`
    case 'symbol':
      return `${path} is a symbol; JSON.stringify drops the key entirely.`
    case 'bigint':
      return `${path} is a bigint; JSON.stringify throws on it.`
    default:
      break
  }

  const object = value as object
  if (seen.has(object)) {
    return `${path} is a circular reference; JSON.stringify throws on it.`
  }
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      const symbolProblem = findSymbolKeys(object, path)
      if (symbolProblem !== undefined) return symbolProblem
      // 自有可枚举键必须恰好是那串下标。这一条同时挡下两种「数组不是纯数组」：
      //   · 挂了额外属性（`const a = [1]; a.foo = 'x'`）—— JSON 只写下标，`foo` 静默消失；
      //   · 稀疏数组（`[, 1]`）—— 空洞被 JSON 写成 `null`，回来就多了一个不存在过的元素。
      if (Object.keys(object).length !== object.length) {
        return `${path} is a sparse array or carries extra own properties; `
          + 'JSON.stringify keeps only the dense indices.'
      }
      for (let index = 0; index < object.length; index += 1) {
        const problem = findNonJsonValue(object[index], `${path}[${index}]`, seen)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    if (!isPlainObject(object)) {
      return `${path} is ${describe(object)}; JSON.stringify does not preserve it.`
    }
    const symbolProblem = findSymbolKeys(object, path)
    if (symbolProblem !== undefined) return symbolProblem
    for (const [key, child] of Object.entries(object)) {
      const problem = findNonJsonValue(child, `${path}.${key}`, seen)
      if (problem !== undefined) return problem
    }
    return undefined
  } finally {
    // 出递归即移除：`seen` 是路径栈不是访问集，菱形引用不算环（见文件头最后一段）。
    seen.delete(object)
  }
}

/**
 * 校验一份事件载荷能不能原样过 JSON。不通过则 **抛 `TypeError`**。
 *
 * 为什么是抛而不是「报给 onHandlerError 然后把这次事件丢掉」：丢掉等于「订阅了一个永远不来的
 * 事件」，正是收敛事件名要消灭的那种静默失败，换个地方复发而已。而载荷不合规是**发射方的
 * 编程错误**——声明的类型早就拒绝了这些值，能在运行期出现说明有人 `as` 掉了类型或把外部输入
 * 直接当载荷用了。响亮地失败优于静默地正确。
 *
 * 校验发生在**任何 handler 被调用之前**，所以失败是原子的：不会出现「前两个 handler 收到了、
 * 后面的没收到」这种半送达状态。
 *
 * 消息用英文：这是给开发者/运维看的编程错误，与「用户可见的助手文案保持中文」那条规则管的
 * 不是同一批文字（口径同 `hostBridge.ts` 与 `createNodeHostInvoke.ts` 的报错）。
 */
export function assertJsonEventPayload(event: string, payload: unknown): void {
  if (!isPlainObject(payload)) {
    throw new TypeError(
      `Host event "${event}" payload must be a plain object, received ${describe(payload)}.`,
    )
  }
  const problem = findNonJsonValue(payload, 'payload', new Set<object>())
  if (problem !== undefined) {
    throw new TypeError(`Host event "${event}" payload is not JSON-safe: ${problem}`)
  }
}
