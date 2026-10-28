# 项目知识同步：把 .project-lines 与根文档对齐到当前代码

状态：执行中
创建日期：2026-10-28
协调者：主会话（opus）
范围：订正仓库内"项目知识"文档（`.project-lines/` 与根 `README.md`、`CLAUDE.md`）中与代码不符的断言，并补齐 `browser-agent` 这条缺失的结构。
非目标：不动任何源码、不改设计与机制、不重学全部 11 条线、不新增门禁规则。

## 目标与验收

**目标**：仓库有两处"项目知识"入口——`CLAUDE.md` 要求动手前读的 `.project-lines/SKILL.md`（11 条线索引），
以及根 `README.md` 的 Repository layout 与 `CLAUDE.md` 的"当前结构"。它们学于 `1ebe4a0`（2026-08-20，
647 提交 / 1783 跟踪文件），当前 HEAD 已在 `fc2cce0`（775 提交 / 2543 跟踪文件），落后 128 个提交。
按过时索引决定"改哪里"，会把代码放进不存在的位置。

**验收**（可执行）：

- `node scripts/check-docs.js` 通过（本任务全部改动都是 `.md`）。
- `.project-lines/SKILL.md` 不再包含下列已被证伪的断言：桌面壳"已整体删除"、`UndoBar.tsx` 待修 bug、
  "32 注册 / 31 模型可见"、"1787 个跟踪文件"。
- `.project-lines/lines/18-分支-browser-agent.md` 存在，且每条机制结论带 `file:line`。
- 根 `README.md` 与 `CLAUDE.md` 的目录清单包含 `browser-agent/`、`apps/desktop/`、`tools/vision/`。

## 现状事实（写卡前逐条核实，是本树共同的依据）

| 事实 | 证据 |
| --- | --- |
| HEAD `fc2cce0`，`main`，工作区干净；775 提交 / 2543 跟踪文件 | `git rev-parse` / `git rev-list --count` / `git ls-files \| wc -l` |
| 顶层分布：packages 1253 · apps 536 · browser-agent 301 · tools 259 · docs 61 · scripts 59 · evals 22 | `git ls-files` 按首段聚合 |
| `apps/desktop` 是活的 Tauri **薄壳**（14 个跟踪文件，含 `Cargo.toml`、`src/server_sidecar.rs`、3 个测试） | `git ls-files apps/desktop` |
| 它是在 `e52c31d`（2026-08-19 删除桌面）之后由 `bb40e2c`（thin shell + desktop CI）加回来的 | `git log --oneline --first-parent -- apps/desktop` |
| **宿主仍然只有两态**：`HostKind = 'server' \| 'static'` | `apps/web/src/host/resolveHost.ts:29` |
| `threeModeSmoke` 的"三模式"是三种**运行形态**（纯 Web / 浏览器 server / Tauri sidecar），不是三个宿主态 | `apps/desktop/tests/threeModeSmoke.test.mjs`：三个 `test(...)` 分别验 `static`、browser-server、tauri-sidecar |
| agent 循环仍在浏览器：`apps/server` 对 core 只有 type-only 依赖 | `apps/server/src/invokeRoute.ts:26`、`apps/server/src/invokeRouteError.ts:57` |
| `SESSION_SLOTS` 仍是 10 槽 | `packages/agent-core/src/state/sessionSlots.ts` |
| `UndoBar.tsx` **已不存在**；全仓只剩 core 的 `state/undoBarrier.ts` | `git ls-files \| grep -i undobar` 仅两项；`apps/web/src` 下"撤销"只命中配置撤销 |
| `tools/standard` 声明"7 域 37 个标准工具"，比索引记录的"32 注册 / 31 可见"多出 vision 域 | `tools/standard/src/index.ts` 计数注释；`tools/` 下 37 个工具子目录 |
| `browser-agent` 有 9 个 workspace 包、`tools/` 下 23 个工具目录（README 声明 25 个模型可见工具） | `browser-agent/*/package.json`；`browser-agent/tools/*/src/*/` |
| `browser-agent` 在根 `README.md`、`CLAUDE.md`、`docs/README.md` 中**零命中** | `rg browser-agent -g '*.md'` 只命中它自己的 README |
| `browser-agent` 的实现记录 `.tasks/browser-agent/*.md`（28 个文件）已被 `90e20ac` 删除 | `git show --stat d5d4298` / `git ls-files .tasks` 为空 |
| `browser-agent` 复用同一个内核：`createCore` + `registerTools` 槽 + IndexedDB 三驱动 | `browser-agent/agent/src/client.ts:71`、`:84`、`:91` |
| 唯一的工具家族装配点是 sidepanel 的一行 | `browser-agent/extension/src/sidepanel.tsx:21`、`:23` |
| 两道门禁当前是绿的 | 实跑 `check-boundaries`（1137 文件 / 11 规则）、`check-docs`（170 个 md） |

## 任务树

```text
KB-SYNC  项目知识同步
├─ KB-SYNC-00  落本树并登记 docs 索引
├─ KB-SYNC-10  订正 .project-lines/SKILL.md 的 4 处已证伪断言
├─ KB-SYNC-20  新增 18-分支-browser-agent.md 线文件
├─ KB-SYNC-30  根 README.md 补 Repository layout
├─ KB-SYNC-40  CLAUDE.md 补「当前结构」
└─ KB-SYNC-90  独立复核与最终验收
```

## 叶子任务表

| ID | 责任 | Owner model | Primary files | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- | --- |
| KB-SYNC-00 | 落本树 + docs 索引行 | sonnet | `docs/knowledge-sync-issues.md`、`docs/README.md` | — | `check-docs` 通过 | DONE（随本卡提交） |
| KB-SYNC-10 | 订正索引 4 处过期断言 | sonnet | `.project-lines/SKILL.md` | 00 | 四处断言改为与「现状事实」一致，且注明核实日期 | TODO |
| KB-SYNC-20 | 新写 browser-agent 线文件 | opus | `.project-lines/lines/18-分支-browser-agent.md` | 00 | 每条机制结论带 `file:line`；≤300 行 | TODO |
| KB-SYNC-30 | README 补 layout | sonnet | `README.md` | 00 | layout 含 `browser-agent/`、`apps/desktop/`、`tools/vision/` | TODO |
| KB-SYNC-40 | CLAUDE.md 补当前结构 | sonnet | `CLAUDE.md` | 00 | 「当前结构」含上述三项；六域表述改为七域 | TODO |
| KB-SYNC-90 | 复核与验收 | opus（与实现者分离） | — | 10/20/30/40 | 逐条抽查未自证事实 + `check-docs` 绿 + 报告偏差 | TODO |

## 并发批次

本树**不并行**，全部串行，理由写明：五个叶子有三处改动面冲突的实际情况——

- 10 与 20 都改 `.project-lines/`，20 还要被 10 的索引引用（20 的新行要进 SKILL.md 的线表），
  顺序只能是 20 先定稿、10 再引用；本树按 10 只改"过期断言"、20 只新增文件来消歧，
  但 SKILL.md 的线表新增一行仍属 10 的改动面，故 10 必须在 20 之后收尾。
- 30 与 40 分别改两个根文档，互不重叠，可以并行；但它们都要引用 20 定下的结构结论，
  否则三处描述会各自再漂一次。
- 故实际执行顺序是 00 → 20 → 10 → {30, 40} → 90。

**这些卡由主会话亲自执行，不派子 agent**：全部是对外知识文档的订正，判据是"与已核实的代码事实逐条一致"，
而子 agent 拿不到本会话已完成的 128 提交对账上下文，重新核实一遍的成本高于收益，且编造事实的风险更高于并行收益。
此为本树的显式例外，记在卡外，供复核者核对。

## 验证与交付

- 每卡一枚 conventional commit，单行主题、无 body；只 stage 本卡文件。
- 改 `.md` 的卡一律跑 `node scripts/check-docs.js`。
- KB-SYNC-90 复核时要**独立抽查**：不采信前序卡的陈述，重新 `git ls-files` /
  `rg` 抽 2–3 条事实，并确认真实执行过 `check-docs`。
