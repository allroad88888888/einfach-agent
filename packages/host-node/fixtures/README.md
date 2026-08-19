# 行为 fixture（原 Rust ↔ TS 对拍）

> **⚠️ 只剩一侧了。** 这套 fixture 立起来时有两个驱动器：TS 一个、Rust 一个，同一组输入喂进去
> 两边输出必须逐字段相同。**Rust 那一侧随 T1（提交 `e52c31d`）连同整个 `apps/desktop/` 删除了**，
> 只能从 Git 历史读；`cargo test … parity` 这条命令不再存在。
>
> 于是这些 JSON 今天的身份变了：它们不再是「两个实现之间的对拍」，而是**从已删除的 Rust 实现里
> 抽取出来、被冻结下来的期望值**——一组"当年那份实现在这些输入上给的就是这个"的行为快照。
> 这仍然是它们最大的价值：Node 侧任何一次重构改变了其中一条，都会当场红，而那条红意味着
> **行为偏离了移植来源**，不是「换了个写法」。所以下面所有关于"两侧""对拍口径"的说法，
> 一律读作**为什么当初把期望值写成这个形状**，不要照着去找那个 Rust 驱动器。

| 侧 | 驱动器 | 怎么跑 |
| --- | --- | --- |
| TypeScript | `../src/parity/*.parity.test.ts` | `pnpm exec vitest run packages/host-node` |
| ~~Rust~~ | ~~`apps/desktop/src/*_parity_tests.rs`~~ | **已随 T1 删除** |

## 为什么要有它

W 线把 `apps/desktop/src/workspace_*.rs` 等价移植成了 `packages/host-node/src/`。「等价」在
W16 之前**只由移植者的人工比对保证**——两边的测试各写各的，没有任何机制保证它们在测同一件事。
这些 fixture 就是那个机制：一组输入喂进去，两边的输出必须逐字段相同。

所以 fixture 的价值排序是 **能抓到行为分岔 > 覆盖率 > 好看**。一组喂进去必然通过
的用例（比如只断言 `ok === true`）是空跑，不要加。

## 比对口径（当初为什么这样写期望值）

- **比对的是解析后的结构，不是字符串。** 桌面侧 `Cargo.toml` 的 `serde_json` 没开
  `preserve_order`，`Value::Object` 底层是 `BTreeMap`，重新序列化时字段按 key 字节序重排；
  JS 的 `JSON.parse` → `JSON.stringify` 保留插入序。**键顺序不算差异**。
- **键的有无算差异。** Rust 的 `skip_serializing_if = "Option::is_none"` 会让那个键整个消失
  （`changeSummary`、`diff`），而没有该属性的 `Option` 序列化成显式 `null`（`changeSet`、
  `error`）。TS 侧驱动器先把结果过一遍 `JSON.parse(JSON.stringify(value))` 再比——`undefined`
  的键因此消失，与 serde 的 skip 对齐，"少写一个 `null`" 这类分岔才暴露得出来。
- **同一仓库两种线上形状，不要统一。** `workspace_write_result.rs` 的 `WorkspaceWriteResult`
  没有 `rename_all`，顶层键是 snake_case；`workspace_read_types.rs` / `workspace_patch_result.rs`
  带 `rename_all = "camelCase"`。期望值按各自实际形状写（这条主要影响 W17）。
- **错误文案里带 OS 错误串的用例当年不能对拍。** Rust 的 `io::Error` 是
  `No such file or directory (os error 2)`，Node 的是 `ENOENT: no such file or directory, open '…'`
  ——同一件事两句话，**这是两个运行时的差异不是移植 bug**。凡是期望值里会出现这一段的场景
  （读不到条目、父目录是文件、权限不足）一律不进 fixture，靠 colocated 测试盯（Node 侧的还在）。
- **错误文案里带 resolved 绝对路径的用例也不能进（W17 新发现）。** `workspace_read_paths.rs`
  的 `display_path` 在越界类错误里报的是 `canonicalize` 之后的**绝对路径**，不是 workspace
  相对路径；而两侧驱动器建临时 workspace 用的命名方案完全不同（Rust 是
  `web_agent_parity_<pid>_<seq>`，Node 是 `mkdtemp` 的随机后缀），没有任何机制能让它们生成
  同一个字符串。`offset 超出文件大小`（`workspace_read_bytes.rs`）、`startLine 超出总行数`
  （`workspace_read_lines.rs`）这两类拒绝正是如此——**这不是移植 bug，是两侧临时目录路径
  天生不同**，一律不进 fixture，靠两侧各自的 colocated 测试盯（Node 侧已有
  `bytesRead.test.ts` 的等价用例，Rust 侧目前**没有**，见下面「目前没覆盖的」）。判断一条错误
  文案能不能进 fixture，先看它是不是由 `display_path` / `relative_path` 拼出来的：后者是
  workspace 相对路径，跨临时目录也稳定，能进；前者是绝对路径，不能进。

## 一处**故意不对齐**的差异（已知豁免）

`apps/desktop/src/workspace_common.rs:143`（已随 T1 删除）对每个读取块单独跑
`String::from_utf8_lossy`，多字节字符被块边界劈开时两半各自变成 `U+FFFD`——中文输出只要跨块就
坏字。Node 侧用 `StringDecoder` 把块尾不完整序列留到下一块，被劈开时给的是**正确**结果
（理由记在 `../src/workspace/common/index.ts` 的文件头）。

当年的裁决是「该改的是 Rust 侧，不是把 Node 改回去凑对拍」，所以本目录的 fixture 一律不构造
「一次读取跨过块边界的多字节字符」。**Rust 侧已经不存在了，这条豁免因此永久成立**：
这个空缺不必再补，Node 的行为就是正确行为。

## 六组 fixture

| 文件 | 形态 | 盯的是什么 | 期望值抽自（已删的 Rust 测试） |
| --- | --- | --- | --- |
| `change-summary.json` | 纯函数 | `compute_change_summary` / `computeChangeSummary`：头尾裁剪、`@@` 行号、LCS 取等方向、`str::lines()` 语义、截断 | 无（Rust 侧这个函数原本零测试） |
| `patch-stage-rules.json` | 纯规则 | 一个补丁操作作用在暂存状态上的结果与错误文案 | `workspace_patch_stage_tests.rs` |
| `patch-pipeline.json` | 带 IO | 整条补丁流水线：初始文件树 + 操作 → 完整回执 JSON + 落盘后的树 | `workspace_patch_pipeline_tests.rs`、`workspace_patch_guard_tests.rs` |
| `change-batch-revert.json` | 带 IO | 批量回滚：账本创建序、预检冲突、dryRun、重复 id、跳过已回滚 | `workspace_change_journal_batch_tests.rs` |
| `write-limits.json` | 带 IO | 单次写入的大小上限、可逆预算与守卫：dry run、显式 maxBytes 拒绝、create/upsert 撞见守卫、`expectedOldContent` / `expectedContentHash` 不匹配 | `workspace_write_pipeline_tests.rs`、`workspace_write_guard.rs` |
| `read-limits.json` | 带 IO | 字节偏移与行定位共用的读取入口：多字节字符边界无损分页、截断标记、maxBytes 按整行截断、offset/startLine 冲突判定 | `workspace_read_bytes_tests.rs`、`workspace_read_lines_tests.rs` |

带 IO 的四组**由驱动器自己建临时目录**，fixture 只描述「初始文件树 + 操作 + 期望结果」；临时
目录本身不进 fixture。纯的两组一个目录都不建（`stageOperation` 要一个存在的 root 做路径解析，
驱动器建一个空目录并**预置暂存表**，磁盘全程不被读写）。

`write-limits.json` 与前两组带 IO 的 fixture 有一处结构性差异：`write_workspace_file` 只碰**一个**
目标路径，没有「写完之后树里多一个文件」的穷举风险，所以它不做整棵树扫描，`expected` 只有
`result` 与可选的 `fileContent`（那一个目标文件跑完之后的内容，`null` = 不该存在）。
`read-limits.json` 干脆不做任何落盘断言——读操作本来就不改磁盘。

## 各文件的 schema

所有文件的顶层都是 `{ "target": string, "cases": Case[] }`。`target` 只是给人看的一句话，
说明这组喂的是哪个函数。每个 case 都有 `name`（唯一，驱动器用它当测试名）与可选的
`source`（抽自哪个 Rust 测试）。

### `change-summary.json`

```jsonc
{
  "name": "…",
  "before": "keep\nold\n",   // string | null（null = 文件是新建的）
  "after": "keep\nnew\n",
  "expected": {              // FileChangeSummary 的完整 JSON
    "linesAdded": 1, "linesRemoved": 1, "beforeLines": 2, "afterLines": 2,
    "diff": "@@ -2,1 +2,1 @@\n-old\n+new",   // 无变动时**整个键不出现**
    "diffTruncated": false, "approximate": false
  }
}
```

### `patch-stage-rules.json`

```jsonc
{
  "name": "…",
  "path": "existing.txt",      // 本 case 里所有操作共用的路径；驱动器会断言这一点
  "initial": { "initial": "on disk", "current": "on disk", "executable": null },
  "steps": [
    { "operation": { "type": "delete_file", "path": "existing.txt" },
      "expect": { "state": { "initial": "on disk", "current": null, "executable": null } } },
    { "operation": { "type": "add_file", "path": "existing.txt", "content": "replaced" },
      "expect": { "error": "file already exists on disk; use overwrite_file to replace an existing file" } }
  ]
}
```

`expect` 恰好有 `state` 或 `error` 之一。**报错的那一步不改状态**，下一步接着用上一步的状态
（两侧实现都是如此：Rust 的四个分支都在赋值之前返回 `Err`，TS 的 `nextFileState` 返回新对象、
抛错时调用方不写回）。

一个 case 只碰一条路径是**刻意的**：跨路径的相互作用属于流水线，在 `patch-pipeline.json` 里测。

### `patch-pipeline.json`

```jsonc
{
  "name": "…",
  "unixOnly": true,                                   // 可选，默认 false
  "initialFiles": { "edit.txt": "keep\nold\n" },      // 建 workspace 时先写下的文件
  "operations": [ /* 命令入参里 operations[] 的原样形状 */ ],
  "dryRun": false,
  "changeContext": { "changeId": "…", "sessionId": "…", "runId": "…", "toolCallId": "…" },  // 可选
  "expected": {
    "result": { /* WorkspacePatchResult 的完整 JSON */ },
    "files": { "edit.txt": "keep\nnew\n" },           // 跑完之后 workspace 里的**全部**普通文件
    "executable": { "run.sh": true },                 // 可选，非 unix 平台跳过这一段断言
    "journalEntries": { "patch-change": "applied" }   // 可选；值为 null = 该条目文件不该存在
  }
}
```

`operations[]` 写的就是线上形状，两层大小写不同款别写错：判别键 `type` 的取值是 **snake_case**
（`add_file` / `delete_file` / `replace` / `overwrite_file`），载荷字段是 **camelCase**
（`oldContent` / `expectedContentHash` / `oldText` / `newText` / `expectedReplacements`）。

`expected.files` 是**穷举**：跑完之后 workspace 里多一个文件或少一个文件都算失败。日志目录是
workspace 的**兄弟目录**，不在这次枚举里。

### `change-batch-revert.json`

```jsonc
{
  "name": "…",
  "initialFiles": { "a.txt": "a-3" },
  "changeSets": [                        // 按数组顺序登记，于是数组顺序 = createdAt 升序
    { "id": "batch-1", "status": "applied",     // "prepared" | "applied" | "reverted"
      "files": [ { "path": "a.txt", "before": "a-1", "after": "a-2" } ] }  // before/after 可为 null
  ],
  "revert": { "changeSetIds": ["batch-1", "batch-2"], "dryRun": false },
  "expected": {
    "result": { /* WorkspaceRevertResult 的完整 JSON */ },
    "files": { "a.txt": "a-1" },                        // 穷举，同上
    "entries": { "batch-1": "reverted" }                // 跑完之后各条目的 status
  }
}
```

驱动器直接调**批量**入口（`revert_change_sets_blocking` / `revertChangeSets`），不经命令层的
「一条走单条、多条走批量」分流——fixture 抽自 `workspace_change_journal_batch_tests.rs`，
测的就是批量那条路。

### `write-limits.json`

```jsonc
{
  "name": "…",
  "source": "workspace_write_pipeline_tests.rs::…",     // 可选，抽自哪个 Rust 测试
  "initialFiles": { "existing.txt": "line\n\n" },        // 建 workspace 时先写下的文件
  "request": {                                            // WriteWorkspaceFileRequest 的字段名（camelCase）
    "path": "existing.txt", "content": "new", "mode": "overwrite",
    "expectedOldContent": "line\n"                        // 其余字段（maxBytes/dryRun/encoding/…）按需给
  },
  "expected": {
    "result": { /* WorkspaceWriteResult 的完整 JSON，顶层 snake_case */ },
    "fileContent": "line\n\n"                             // 目标文件跑完之后的内容；null = 不该存在
  }
}
```

驱动器直接调 `write_workspace_file_blocking_with_journal` / `writeWorkspaceFile`（不经命令层的
snake_case 入参收窄），`journal` 恒为空——本组不测变更日志，那是 `patch-pipeline.json` /
`change-batch-revert.json` 的地盘。`request` 里没写的字段一律视为「没传」，两侧驱动器都用
「键缺席 = None/undefined」这一条语义读取。

**这一组是 `WorkspaceWriteResult` 顶层 snake_case、`change_summary` 内层却 camelCase 的
第一个见证者**——同一份 JSON 里两种大小写混着来，照抄，不要统一（这是 findings #12，见仓库
issue 树）。

**内容大到需要几十 KB 以上文本才能触发的边界，本组一律不收**（与「目前没覆盖的」同一条
理由）：`REVERSIBLE_MAX_BYTES`（1 MiB）与 `absent_max_bytes_allows_writes_past_the_old_default`
需要的「明显大于任何合理默认值」的内容都是如此。`reversible: false` 这个字段改走一条更便宜的
路径覆盖——base64 内容里带一个 `\0` 字节，`reversibleReason` 判成 `binary content is not
reversible`，六个字节就能触发，不需要造大文件。

### `read-limits.json`

```jsonc
{
  "name": "…",
  "source": "workspace_read_bytes_tests.rs::…",
  "initialFiles": { "paged.txt": "ab你cd" },
  "request": {                                    // read_workspace_file 顶层入参，snake_case
    "path": "paged.txt", "max_bytes": 4, "offset": 0
    // 行定位模式改给 start_line / line_count
  },
  "expected": {
    "result": { /* ReadWorkspaceFileResult 的完整 JSON，camelCase */ }
    // 或者恰好给这一个：
    // "error": "…"        // 逐字比较，不是子串匹配
  }
}
```

驱动器调的是**顶层分派** `read_workspace_file_blocking_at_lines` / `readWorkspaceFile(args)`，
不是直接调字节或行两个子实现——分派本身（两个行参数都缺席才走字节模式、`offset` 与
`start_line` 冲突判定）也是要盯的行为。读操作不改磁盘，`expected` 没有落盘断言。

## 新增一组 fixture 要改哪几个文件

以「给 `workspace_write` 加一组」为例（W17 就是这件事）：

1. 本目录加 `write-<aspect>.json`，schema 照上面挑一个最接近的抄。
2. `../src/parity/write<Aspect>.parity.test.ts`——TS 驱动器。加载走
   `parityFixtures.testHarness.ts` 的 `loadParityFixture('write-<aspect>.json')`，比对走同文件的
   `toComparableJson`。
3. 本文件的「六组 fixture」表加一行，并按需加一段 schema 说明。

（原来这里还有第 3、4 步：写 Rust 驱动器、把它挂进被测模块。那两步随 T1 一起没了——
今天只有一个驱动器。）

## 目前没覆盖的（诚实记录）

- **`approximate`（LCS 预算降级）**。触发条件是裁剪后的区间 `before × after > 800 × 800`，
  最省的构造也要 1600 行文本，写成 fixture 是两段约 10 KB 的机器生成字符串——放进来会让这份
  「照着能加」的范式变成没人看得懂的数据块。两侧各有 colocated 测试。
- **几十 KB 以上文本才能撞上的容量边界**（W17 复核后合并的一条，原「1 MiB 文本上限」在此并入）。
  同一类理由覆盖三个具体常量：`REVERSIBLE_MAX_BYTES`（1 MiB，撞上要喂 100 万+ 字节）、
  `MAX_HASH_BYTES`（8 MiB，`content_hash_is_skipped_past_the_writable_ceiling`）、
  `MAX_READ_BYTES` 与 `MAX_TRACE_READ_BYTES` 的落差（200 KB vs 2 MB，
  `trace_read_has_a_scoped_larger_ceiling`）。**`reversible: false` 这一个字段已经有更便宜的
  覆盖**（见 `write-limits.json` 的 base64 + `\0` 用例），真正没覆盖的是这几个**具体数值**
  本身——两侧的常量是否真的相等，只能靠读源码对照或专门造大文件验证，本目录的 fixture 范式
  不适合它们。两侧各有 colocated 测试锁住数值。
- **符号链接相关的拒绝**（`symlink paths are not supported`）。schema 里还没有「初始软链」这一
  项；当年的成本是"要同时动两个驱动器"，今天只剩一个，这条便宜了。
- **`workspace_mismatch`**、**批量的 path-delete 重叠守卫**：前者要第二个 workspace root，
  后者要能在 fixture 里登记 `movedPaths` / `createdPaths`。
- **越界类错误文案里的绝对路径**（W17 新增的一类，见「比对口径」第五条）：`offset 超出文件
  大小`、`startLine 超出总行数`。当年记的是「Rust 侧连 colocated 测试都没有」这处覆盖不对称；
  Rust 侧已删，不对称随之消失，Node 侧的 `bytesRead.test.ts` 就是唯一也是足够的覆盖。
