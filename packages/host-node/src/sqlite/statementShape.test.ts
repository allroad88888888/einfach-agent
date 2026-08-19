import { describe, expect, it } from 'vitest'
import { inspectSingleStatement } from './statementShape'

describe('inspectSingleStatement', () => {
  it('认得出首关键字与 $N 占位符个数', () => {
    expect(inspectSingleStatement('SELECT id, meta FROM sessions')).toEqual({
      keyword: 'SELECT',
      parameterCount: 0,
    })
    expect(
      inspectSingleStatement('INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)'),
    ).toEqual({ keyword: 'INSERT', parameterCount: 2 })
  })

  it('同一个 $1 出现多次只算一个参数', () => {
    // observability-sqlite 的恢复语句就是这个形状：`ended_at = $1, duration_ms = MAX(0, $1 - …)`，
    // 只传一个值。按「出现次数」计数会要求传两个，那条语句当场就跑不了。
    const shape = inspectSingleStatement(
      "UPDATE trace_spans SET ended_at = $1, duration_ms = MAX(0, $1 - started_at) WHERE status = 'running'",
    )
    expect(shape).toEqual({ keyword: 'UPDATE', parameterCount: 1 })
  })

  it('分号结尾仍是一条语句，分号之后还有语句则拒绝', () => {
    expect(inspectSingleStatement('DELETE FROM history_log WHERE session_id = $1;').keyword).toBe(
      'DELETE',
    )
    // node:sqlite 的 prepare() 对这种输入既不报错也不执行第二条——只编译第一条，剩下的字节
    // 被丢掉。不拦的话调用方会拿到一个成功的回执和半份数据。
    expect(() =>
      inspectSingleStatement("INSERT INTO t (v) VALUES ('a'); INSERT INTO t (v) VALUES ('b')"),
    ).toThrow(/只能执行一条 SQL 语句/)
  })

  it('分号之后的空白与注释放行', () => {
    expect(inspectSingleStatement('SELECT 1; -- 收尾注释').keyword).toBe('SELECT')
    expect(inspectSingleStatement('SELECT 1;\n/* 收尾块注释 */\n').keyword).toBe('SELECT')
  })

  it('字符串字面量与注释里的分号 / 占位符不作数', () => {
    // 这条是「引号判断必须排在语句结束判断之后」的回归：排反了的话 `; 'x'` 会被引号分支
    // 整段跳过，第二条语句静默溜走。
    expect(inspectSingleStatement("SELECT 'a;b' AS v").parameterCount).toBe(0)
    expect(inspectSingleStatement("SELECT 'a$1b' AS v").parameterCount).toBe(0)
    expect(inspectSingleStatement("SELECT 'it''s' AS v").keyword).toBe('SELECT')
    expect(inspectSingleStatement('SELECT 1 -- $1; 还有半句\n').parameterCount).toBe(0)
    expect(inspectSingleStatement('SELECT 1 /* $1; 还有半句 */').parameterCount).toBe(0)
    expect(inspectSingleStatement('SELECT "odd;name" FROM t').keyword).toBe('SELECT')
    expect(() => inspectSingleStatement("SELECT 1; 'x'")).toThrow(/只能执行一条 SQL 语句/)
  })

  it('事务控制语句一律拒绝', () => {
    // 关键在于**为什么**：Node 侧是单个句柄，BEGIN…COMMIT 真的会成立；桌面侧是 sqlx 连接池，
    // 同样的写法语句会落到不同连接上、事务根本不成立还会遗留写锁。放行 = 制造「本地能跑、
    // 换宿主就坏」。
    for (const sql of ['BEGIN', 'begin immediate', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s']) {
      expect(() => inspectSingleStatement(sql), sql).toThrow(/不接受事务控制语句/)
    }
  })

  it('ATTACH / DETACH 拒绝，SELECT 里的近似词放行', () => {
    expect(() => inspectSingleStatement("ATTACH DATABASE '/tmp/other.db' AS other")).toThrow(
      /只连一个库文件/,
    )
    expect(() => inspectSingleStatement('DETACH other')).toThrow(/只连一个库文件/)
    // 判据是**首**关键字，不是「文本里出现过」——否则表名叫 beginners 的查询会被误杀。
    expect(inspectSingleStatement('SELECT * FROM beginners WHERE id = $1').parameterCount).toBe(1)
  })

  it('$N 之外的占位符形式受控失败', () => {
    // 入参是位置数组，与 `?` / `:name` 之间没有能自证正确的映射；猜一个出来就是又造一种
    // 「本地能跑」。
    expect(() => inspectSingleStatement('SELECT * FROM t WHERE id = ?')).toThrow(/只支持 \$1/)
    expect(() => inspectSingleStatement('SELECT * FROM t WHERE id = :id')).toThrow(/只支持 \$1/)
    expect(() => inspectSingleStatement('SELECT * FROM t WHERE id = @id')).toThrow(/只支持 \$1/)
    expect(() => inspectSingleStatement('SELECT * FROM t WHERE id = $id')).toThrow(/编号形式/)
  })

  it('占位符编号必须从 $1 起连续', () => {
    expect(() => inspectSingleStatement('SELECT $2 AS v')).toThrow(/必须从 \$1 起连续/)
    expect(() => inspectSingleStatement('SELECT $1, $3 FROM t')).toThrow(/必须从 \$1 起连续/)
  })

  it('空语句与未闭合的引号 / 块注释都是受控失败', () => {
    expect(() => inspectSingleStatement('   \n  ')).toThrow(/空语句/)
    expect(() => inspectSingleStatement('-- 只有注释')).toThrow(/空语句/)
    expect(() => inspectSingleStatement("SELECT 'unterminated")).toThrow(/未闭合/)
    expect(() => inspectSingleStatement('SELECT 1 /* 未闭合')).toThrow(/未闭合的块注释/)
  })
})
