# Rust ↔ TS 对拍 fixture

这个目录里的 JSON 是**语言无关的输入/期望**，由两侧各自的驱动器读取并跑同一组用例：

| 侧 | 驱动器 | 怎么跑 |
| --- | --- | --- |
| TypeScript | `../src/parity/*.parity.test.ts` | `pnpm exec vitest run packages/host-node` |
| Rust | `apps/desktop/src/*_parity_tests.rs` | `cargo test --manifest-path apps/desktop/Cargo.toml parity` |

## 为什么要有它

W 线把 `apps/desktop/src/workspace_*.rs` 等价移植成了 `packages/host-node/src/`。「等价」在
W16 之前**只由移植者的人工比对保证**——两边的测试各写各的，没有任何机制保证它们在测同一件事。
这些 fixture 就是那个机制：一组输入喂进去，两边的输出必须逐字段相同。

所以 fixture 的价值排序是 **能抓到两边行为分岔 > 覆盖率 > 好看**。一组喂进去两边输出必然相同
的用例（比如只断言 `ok === true`）是空跑，不要加。

## 比对口径

- **比对的是解析后的结构，不是字符串。** `apps/desktop/Cargo.toml` 的 `serde_json` 没开
  `preserve_order`，`Value::Object` 底层是 `BTreeMap`，重新序列化时字段按 key 字节序重排；
  JS 的 `JSON.parse` → `JSON.stringify` 保留插入序。**键顺序不算差异**。
- **键的有无算差异。** Rust 的 `skip_serializing_if = "Option::is_none"` 会让那个键整个消失
  （`changeSummary`、`diff`），而没有该属性的 `Option` 序列化成显式 `null`（`changeSet`、
  `error`）。TS 侧驱动器先把结果过一遍 `JSON.parse(JSON.stringify(value))` 再比——`undefined`
  的键因此消失，与 serde 的 skip 对齐，"少写一个 `null`" 这类分岔才暴露得出来。
- **同一仓库两种线上形状，不要统一。** `workspace_write_result.rs` 的 `WorkspaceWriteResult`
  没有 `rename_all`，顶层键是 snake_case；`workspace_read_types.rs` / `workspace_patch_result.rs`
  带 `rename_all = "camelCase"`。期望值按各自实际形状写（这条主要影响 W17）。
- **错误文案里带 OS 错误串的用例不能对拍。** Rust 的 `io::Error` 是
  `No such file or directory (os error 2)`，Node 的是 `ENOENT: no such file or directory, open '…'`
  ——同一件事两句话，**这是两个运行时的差异不是移植 bug**。凡是期望值里会出现这一段的场景
  （读不到条目、父目录是文件、权限不足）一律不进 fixture，靠两侧各自的 colocated 测试盯。

## 一处**故意不对齐**的差异（已知豁免）

`apps/desktop/src/workspace_common.rs:143` 对每个读取块单独跑 `String::from_utf8_lossy`，
多字节字符被块边界劈开时两半各自变成 `U+FFFD`——中文输出只要跨块就坏字。Node 侧用
`StringDecoder` 把块尾不完整序列留到下一块，被劈开时给的是**正确**结果
（理由记在 `../src/workspace/common/index.ts` 的文件头）。

**该改的是 Rust 侧，不是把 Node 改回去凑对拍。** 所以本目录的 fixture 一律不构造「一次读取跨过
块边界的多字节字符」，撞上就是撞上了这条豁免，不是移植 bug。

## 四组 fixture

| 文件 | 形态 | 盯的是什么 | Rust 素材 |
| --- | --- | --- | --- |
| `change-summary.json` | 纯函数 | `compute_change_summary` / `computeChangeSummary`：头尾裁剪、`@@` 行号、LCS 取等方向、`str::lines()` 语义、截断 | 无（Rust 侧这个函数原本零测试） |
| `patch-stage-rules.json` | 纯规则 | 一个补丁操作作用在暂存状态上的结果与错误文案 | `workspace_patch_stage_tests.rs` |
| `patch-pipeline.json` | 带 IO | 整条补丁流水线：初始文件树 + 操作 → 完整回执 JSON + 落盘后的树 | `workspace_patch_pipeline_tests.rs`、`workspace_patch_guard_tests.rs` |
| `change-batch-revert.json` | 带 IO | 批量回滚：账本创建序、预检冲突、dryRun、重复 id、跳过已回滚 | `workspace_change_journal_batch_tests.rs` |

带 IO 的两组**两侧各自建临时目录**，fixture 只描述「初始文件树 + 操作 + 期望结果」；临时目录
本身不进 fixture。纯的两组一个目录都不建（Rust 的 `stage_operation` 要一个存在的 root 做路径
解析，驱动器建一个空目录并**预置暂存表**，磁盘全程不被读写）。

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

## 新增一组 fixture 要改哪几个文件

以「给 `workspace_write` 加一组」为例（W17 就是这件事）：

1. 本目录加 `write-<aspect>.json`，schema 照上面挑一个最接近的抄。
2. `../src/parity/write<Aspect>.parity.test.ts`——TS 驱动器。加载走
   `parityFixtures.testHarness.ts` 的 `loadParityFixture('write-<aspect>.json')`，比对走同文件的
   `toComparableJson`。
3. `apps/desktop/src/workspace_write_<aspect>_parity_tests.rs`——Rust 驱动器。加载走
   `crate::parity_fixtures` 的 `load_fixture("write-<aspect>.json")`。
4. 在被测模块里挂一行
   `#[cfg(test)] #[path = "workspace_write_<aspect>_parity_tests.rs"] mod parity_tests;`
   ——**驱动器要住在它需要的 `pub(super)` 项所在的那个模块里**，否则拿不到被测函数。
5. 本文件的「四组 fixture」表加一行。

## 目前没覆盖的（诚实记录，W17 的候选）

- **`approximate`（LCS 预算降级）**。触发条件是裁剪后的区间 `before × after > 800 × 800`，
  最省的构造也要 1600 行文本，写成 fixture 是两段约 10 KB 的机器生成字符串——放进来会让这份
  「照着能加」的范式变成没人看得懂的数据块。两侧各有 colocated 测试。
- **1 MiB 文本上限**。同理：要撞上 `Buffer.byteLength` 与 `.length` 的分岔得喂一段 35 万字的
  多字节文本。
- **符号链接相关的拒绝**（`symlink paths are not supported`）。schema 里还没有「初始软链」这一
  项，加它要同时动两个驱动器。
- **`workspace_mismatch`**、**批量的 path-delete 重叠守卫**：前者要第二个 workspace root，
  后者要能在 fixture 里登记 `movedPaths` / `createdPaths`。
