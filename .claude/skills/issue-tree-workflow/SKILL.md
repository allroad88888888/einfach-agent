---
name: issue-tree-workflow
description: 本仓库的标准做事方式——先把一项改动落成本地 issue 树 MD，拆到「一个 issue = 一次 commit」的粒度，按风险给每个 issue 指派模型，再逐个派子 agent 执行、主会话亲自验证、每完成一个提交一次。何时用：跨包改动、需要多次提交、有依赖顺序、要并行派活的工程任务，或用户说「开 issue / 拆任务 / 按 issue 做」。何时不用：单文件小改、单点 bug、纯问答——直接做，别开文件。
---

# Issue 树工作流

## 1. 先落 issue 树文件

位置 `docs/<topic>-issues.md`，同时在 [docs/README.md](../../../docs/README.md) 的表里加一行指向它。

docs 有 Markdown 门禁：相对链接必须真实存在。写完跑 `node scripts/check-docs.js`。

文件结构 = 编号树 + 每个 issue 一张固定字段的卡。分支用大写字母，issue 用 `字母+数字`。

## 2. 拆分粒度

硬标准：**一个 issue = 一次 commit = 一条 conventional commit 主题能说清**。

说不清就再拆。检验方式同 skill `one-file-one-thing`：能不能用一句不含「和 / 以及」的话描述它。

每张卡必须有这几个字段，缺一不可：

```markdown
### A1 · <一句话标题>

- **依赖**：A0（没有前置写 —）
- **改动面**：具体文件路径，不写"相关文件"
- **判据**：可执行的验证命令 + 可观察的行为变化
- **模型**：opus / sonnet
- **状态**：TODO
```

状态只有 `TODO` / `DOING` / `DONE <commit hash>` 三种。

## 3. 模型指派

| 风险 | 特征 | 模型 |
| --- | --- | --- |
| 高 | 状态机、并发与生命周期、安全边界、跨包契约、数据迁移、会被后续抄的新范式 | opus |
| 低 | 机械改写、移动代码、补测试、改文案、字段透传、纯删除 | sonnet |

拿不准就往高了给。指派写在卡上，派活时照着用，不要临场改主意。

## 4. 执行循环

主会话**只派活和验收，不亲自写实现代码**（派子 agent 是本工作流的组成部分，启用本 skill 即为授权）。

每个 issue：

1. 挑一个依赖已满足的 issue，卡上状态改 `DOING`
2. 用卡上指定的模型派子 agent，prompt 里带全：**卡的全文 + 改动面 + 判据 + 本次相关的 CLAUDE.md 边界规则**（例如工具只能用 `ToolContext`、core 不得反向依赖 tools-*、UI 只能走 commands）
3. 子 agent 交回后**主会话亲自验证**：读 diff、跑判据里的命令。**不采信子 agent 的自述**——它说「测试通过」不算数，你自己跑过才算
4. 不过就打回重做或自己修；过了才提交
5. 卡上状态改 `DONE <hash>`

并行规则：依赖已满足**且改动面不重叠**的 issue 可以同时派。碰同一批文件的必须串行——并行改同文件会互相覆盖。

## 5. 提交

跟本仓库现有历史一致：conventional commit、单行主题、无 body、小写、祈使句。

```
feat(mcp): add connect tool
fix(runtime): close tool calls on stop
refactor(state): move settings atoms out of mcp
docs: ...
```

每个 issue 一次提交。**只 stage 该 issue 的文件**——工作树里通常有别的在途改动，`git add -A` 会把它们卷进来。

状态卡的更新可以并进同一次提交。

## 6. 提交前的门禁

按改动面挑最小集，别无脑全量跑：

| 改了什么 | 至少跑 |
| --- | --- |
| 任何 `.md` | `node scripts/check-docs.js` |
| TS / TSX | `pnpm exec vitest run <相关文件>` 再 `pnpm build` |
| `tools/*` | `pnpm exec vitest run tools` |
| `apps/desktop/src` | `cargo test --manifest-path apps/desktop/Cargo.toml` |

`pnpm build`（`tsc -b`）是唯一类型门禁，仓库没有 lint。

## 7. 收尾

全部 `DONE` 后把 issue 文件从工作树删除，并从 `docs/README.md` 的表里移掉那一行——
本仓库约定：完成的阶段性 PLAN 只保留在 Git 历史里。

## 8. 未决项怎么处理

有开放决策的条目单列一个「未决」分支，**不给编号排期、不指派模型**。
决策没落地就不许开工，也不要用假设替用户做决定。
