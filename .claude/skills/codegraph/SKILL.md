---
name: codegraph
description: 用本仓库的 CodeGraph 索引（.codegraph/）回答 grep 给不出的调用图问题——谁调用了某符号、改它会波及什么、某个 diff 该跑哪些测试、一次拿到符号源码加调用链。探索不熟悉的代码、动共享函数前评估影响、按改动挑测试、跨包追调用路径时使用。纯文本/配置/注释检索仍用 Grep，索引未覆盖的文件也不要用。
---

# CodeGraph 查询

`codegraph` 把仓库解析成符号级调用图，能回答"谁调用它 / 改了会波及谁 / 该跑哪些测试"这类
grep 做不到的问题。

## 前置检查

仅当仓库根有 `.codegraph/` 时可用。没有就跳过本 skill（用 Grep/Read），不要擅自 `codegraph init`
——建索引是用户的决定。

## 按用途选命令

| 你要什么 | 命令 |
| --- | --- |
| 某符号的源码 + 上下游调用链（免 Read） | `codegraph node <symbol>` |
| 改这个符号会波及什么 | `codegraph impact <symbol>` |
| 谁调用了它 / 它调用了谁 | `codegraph callers <symbol>` / `codegraph callees <symbol>` |
| 某片区域的相关符号 + 调用路径 | `codegraph explore <query...>` |
| 按名字找符号 | `codegraph query <search> [-k function]` |
| 改动 → 该跑哪些测试 | `codegraph affected -q -d 1 <files...>` |

加 `-j` 得到 JSON，便于程序化处理。

`node` 会直接输出签名、文档注释、带行号的源码，以及 `Calls →` / `Called by ←` 两条线索，
通常不必再 Read 该文件。

## 本仓库实测校准（重要）

**`affected` 必须用 `-d 1`。** 默认 `-d 5` 在这个 monorepo 里会失真：底层包（`agent-core`、
`agent-ai`）被几乎所有 UI 依赖，深度一放开就退化成"整个 app 的测试"，还会混进
`test/setup.ts` 这种非测试文件。

实测（改 `subagents/routing.ts` + `agent-ai/deepseek.ts`）：

- `-d 1` → 3 个文件，正是对应的 `routing.test.ts` / `deepseek.test.ts` / `modelApi.cache.test.ts`
- `-d 2` → 51 个
- `-d 3` → 61 个

所以：**先跑 `-d 1` 拿到直接测试**，只有在确实要评估广域回归时才逐级放大，且要人工筛。
`affected` 的结果是候选，不是"跑完这些就安全了"——最终仍以 `pnpm build` 类型门禁为准。

`impact` 则相反，默认 `-d 2` 就很准，且能抓到跨包耦合（例如它能指出 `evals/` 下的
`shadowRouteForTask` 依赖 `routeSubagentModel`）。

## 什么时候不要用

- **找字符串、配置、注释、文案** → 用 Grep。CodeGraph 是符号图，不是全文检索。
- **找 interface / type 的成员字段名** → 用 Grep。图里只有**顶层声明**（function、interface、
  type_alias、constant、class 等）；`interface Foo { bar: number }` 里的 `bar` 不是独立节点，
  `query bar` 搜不到。实测：`task-report.ts` 的 `cost_per_pass_pico_usd`、`paired_regressions`
  等字段全部查不到，而同文件的函数都在。
  想确认某文件到底有哪些符号入了图：`codegraph node -f <file> --symbols-only`。
- **索引未覆盖的语言**。当前索引：TypeScript / TSX / Rust / JavaScript / YAML。
  CSS、Markdown、JSON 不在图里。
- **刚改完还没 sync**。索引是快照，不是实时的。
- **需要精确当前内容时**。查到位置后仍应 Read 确认——不要仅凭索引里的旧快照下结论。

## 索引新鲜度

项目配了 Stop hook（`.claude/settings.local.json`），每轮结束后台跑 `codegraph sync -q`
增量更新。若怀疑索引落后（如刚大改完就要查），手动补一次：

```bash
codegraph sync -q && codegraph status
```

`status` 末尾会显示 `✓ Index is up to date`。`sync` 是"自上次索引以来的增量"，漏跑一次
不会丢失——下次会一并补上。
