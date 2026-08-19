// 一次调用只许是一条自包含语句 —— 这条前提的机械判据
// ---------------------------------------------------------------------------
// `SqlExecutor` 只承诺一件事：收**一条**语句，把它执行掉（判据全文见 core 的
// `state/persistence/sqlTransport.ts` 文件头）。本文件是那句承诺在 Node 侧的看门人：执行之前
// 先扫一遍 SQL，不满足就当场失败，而不是「先跑跑看」。
//
// ═══ 三条判据，各自挡住一种**静默**错误 ═══
//
// ① **只能有一条语句。** node:sqlite 的 `prepare()` 对 `"INSERT A; INSERT B"` 既不报错也不执行
//    第二条——它只编译第一条，剩下的字节被丢掉（已实测：两条 INSERT 只落了一行，返回值仍是
//    `{ changes: 1 }`）。于是「顺手传一批语句」的调用方会拿到一个成功的回执和半份数据。
//    这条判据把它变成一次响亮的失败。
//
// ② **不许发事务控制语句**（BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT / RELEASE）。
//    这条不是洁癖，是**跨宿主一致性**：Node 侧是单个 `DatabaseSync` 句柄，多次调用必然落在同一
//    条连接上，所以 `BEGIN` … `COMMIT` 在这里**真的会成立**；而桌面侧底层是 sqlx 连接池，同样
//    的写法语句会被路由到不同连接，事务根本不成立，还会把打开的写事务遗留在某条连接上长期
//    持有写锁（真实烟测日志：`slow statement: INSERT OR REPLACE INTO sessions … elapsed=5.21s`）。
//    「在 Node 上跑通、上桌面/HTTP 就坏」是这棵树反复吃过亏的形态，比两边一起坏更难查。
//    仓库的修法从来不是把语句打包，而是让**每一次写入都是一条自包含的原子语句**（会话列表是
//    单行 blob upsert、恢复快照是条件 UPSERT、删除是 tombstone UPSERT），SQLite 单语句本身即
//    原子，无需任何事务包裹。所以这里把「事务」直接判成非法输入。
//
// ③ **占位符只认 `$N`，且个数必须和 params 对得上。** port 的入参是**位置数组**，而 node:sqlite
//    的匿名绑定会**跳过所有带名字的参数**（`$1` 是有名字的），于是位置绑定当场 SQLITE_RANGE；
//    改走具名绑定后又冒出反向的坑：`select('… WHERE id = $1')` 忘了传 params 时不报错，
//    `$1` 被静默绑成 NULL，一次查询安静地返回空集（已实测）。两头都靠这条判据堵死。
//    仓库现有 SQL 全是 `$N`（sqlx 的写法），`?` / `:name` / `@name` 一律受控失败——它们与位置
//    数组之间没有一个能自证正确的映射，猜一个出来就是在制造第二种「本地能跑」。
//
// 扫描器认识 SQLite 的字符串与注释语法，所以 `'a;b'`、`--` 行注释、`/* */` 块注释里的分号和
// `$1` 都不会被误判。ATTACH / DETACH 一并拒掉：执行面绑定的是**一个**库文件，挂上第二个库等于
// 让「连接归属留在实现里」这条承诺失效，而这两条命令的 SQL 来自外部载荷。

/** 一条语句扫出来的形状。 */
export interface SqlStatementShape {
  /** 首个关键字（大写）。 */
  readonly keyword: string
  /** `$N` 占位符的个数；`N` 必须恰好覆盖 1..count，不允许跳号。 */
  readonly parameterCount: number
}

/** 事务控制语句。`END` 是 `COMMIT` 的别名（作为**首**关键字时不可能是 CASE 的结尾）。 */
const TRANSACTION_KEYWORDS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'])
/** 换/挂库文件。执行面只认自己那一个文件。 */
const DATABASE_KEYWORDS = new Set(['ATTACH', 'DETACH'])

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char)
}

/**
 * 扫一遍 SQL，返回它的形状；任一判据不满足则抛错。
 *
 * 单趟状态机，状态就是「现在在不在引号/注释里」。刻意不用正则先剥再判：先剥字符串的正则在
 * `''` 转义与未闭合引号上都会错，而错的方向是**放行**。
 */
export function inspectSingleStatement(sql: string): SqlStatementShape {
  let keyword = ''
  let statementEnded = false
  const parameters = new Set<number>()
  let index = 0

  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]

    // ── 注释：两种都只是空白，跳过即可（语句结束后也允许出现）
    if (char === '-' && next === '-') {
      const lineEnd = sql.indexOf('\n', index)
      index = lineEnd === -1 ? sql.length : lineEnd + 1
      continue
    }
    if (char === '/' && next === '*') {
      const blockEnd = sql.indexOf('*/', index + 2)
      if (blockEnd === -1) throw new Error('SQL 里有未闭合的块注释')
      index = blockEnd + 2
      continue
    }

    if (/\s/.test(char)) {
      index += 1
      continue
    }

    // 语句结束之后只允许空白与注释，其余一律是「第二条语句」。这道判断必须排在引号之前——
    // 排在后面的话 `SELECT 1; 'x'` 会被引号分支整段跳过，第二条语句于是静默溜走。
    if (statementEnded) {
      throw new Error(
        '一次调用只能执行一条 SQL 语句：分号之后还有内容。批量执行不是本执行面的能力，' +
          '每条写入都必须是一条自包含的原子语句。',
      )
    }

    // ── 引号：字符串字面量与被引起来的标识符。内容整段跳过，里面的 `;` `$1` 都不作数。
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = skipQuoted(sql, index)
      continue
    }

    if (char === ';') {
      statementEnded = true
      index += 1
      continue
    }

    // ── 占位符
    if (char === '$') {
      let cursor = index + 1
      while (cursor < sql.length && /[0-9]/.test(sql[cursor] as string)) cursor += 1
      if (cursor === index + 1) throw new Error('SQL 占位符只支持 $1、$2 … 这种编号形式')
      parameters.add(Number(sql.slice(index + 1, cursor)))
      index = cursor
      continue
    }
    if (char === '?' || ((char === ':' || char === '@') && next !== undefined && isIdentifierChar(next))) {
      throw new Error(
        `SQL 占位符只支持 $1、$2 … 这种编号形式，收到「${char}」：入参是位置数组，` +
          '与其他占位符形式之间没有能自证正确的映射。',
      )
    }

    // ── 首关键字
    if (!keyword && /[A-Za-z_]/.test(char)) {
      let cursor = index
      while (cursor < sql.length && isIdentifierChar(sql[cursor] as string)) cursor += 1
      keyword = sql.slice(index, cursor).toUpperCase()
      assertAllowedKeyword(keyword)
      index = cursor
      continue
    }

    index += 1
  }

  if (!keyword) throw new Error('SQL 是空语句')
  assertContiguousParameters(parameters)
  return { keyword, parameterCount: parameters.size }
}

/** 跳过一段被引起来的内容，返回结束后的下标。`''` / `""` 是转义（重复一次即字面量本身）。 */
function skipQuoted(sql: string, start: number): number {
  const open = sql[start] as string
  const close = open === '[' ? ']' : open
  let index = start + 1
  while (index < sql.length) {
    if (sql[index] === close) {
      // `[ ]` 标识符没有转义形式，其余三种以「重复一次」表示字面量自身。
      if (close !== ']' && sql[index + 1] === close) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  throw new Error(`SQL 里有未闭合的 ${open} 引号`)
}

function assertAllowedKeyword(keyword: string): void {
  if (TRANSACTION_KEYWORDS.has(keyword)) {
    throw new Error(
      `本执行面不接受事务控制语句（${keyword}）：一次调用 = 一条自包含语句，跨调用的事务在` +
        '连接池宿主上根本不成立，在这里成立只会写出「本地能跑、换宿主就坏」的代码。',
    )
  }
  if (DATABASE_KEYWORDS.has(keyword)) {
    throw new Error(`本执行面只连一个库文件，不接受 ${keyword}。`)
  }
}

function assertContiguousParameters(parameters: ReadonlySet<number>): void {
  for (let expected = 1; expected <= parameters.size; expected += 1) {
    if (!parameters.has(expected)) {
      const sorted = [...parameters].sort((left, right) => left - right)
      throw new Error(`SQL 占位符编号必须从 $1 起连续，收到：${sorted.map((n) => `$${n}`).join(' ')}`)
    }
  }
}
