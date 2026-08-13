# 子 Agent 治理：replay、容量与归档

> 草稿。面向已经在产品里上了子 agent、开始被"跑完就丢"困扰的工程师。

## 一、子 agent 跑完之后，你还剩下什么

大部分 agent 框架里，子 agent 是一次性进程：父 agent 派它出去，它跑几轮，回来吐一段 summary，
进程结束。summary 塞进父 agent 上下文，然后——就没有然后了。于是线上开始出现这样的对话：
"昨天那次它为什么改错了文件？"（只剩一句"已完成三处修改"）、"这次烧了多少模型调用？"（没人记）、
"它蒸馏出来的那份任务简报还在吗？"（在某个已经关掉的会话的内存里）。

问题不在于子 agent 跑得好不好，而在于**它跑完之后什么都不剩**。一次派发是一次真实的资源消耗：
N 条模型调用、一棵可能递归展开的执行树、一批中间产物；当临时变量处理，等于放弃排障、成本核算和
经验复用三件事。本文讲另一种做法：**把子 agent 当有生命周期的资产管**——树形结构、预算、归档、
回放、索引，以及配套的运维手段，且都对应仓库里已经跑起来的实现，路径可以直接对照。

## 二、先有树和归档，才谈得上治理

### 2.1 委派是工具，不是内核特性

第一个设计选择：委派能力**不内建在 runtime 内核里**，而是由装配层按槽注入。内核只定义
`DelegationCapability` 契约，应用启动时调用 `configureDefaultDelegation(createDelegationAssembly)`
装入实现（Web 在 `apps/web/src/main.tsx`，CLI 在 `apps/cli/src/runtime.ts`）；
`createCore({ delegation })` 为每个实例装一份隔离的调度器，不注入就是禁用。模型侧看到的是
`tools/agents/` 域的四个工具：`delegate_agent` 派发、`observe_agent` 不阻塞地查状态、
`join_agent` 真正需要结果时才等、`cancel_agent` 取消。

### 2.2 树形地址：`root-01-01`

每个节点在 run 内有一个可读的树地址：根固定 `root`，第 N 个子节点是 `<parent>-NN`，嵌套一层就是
`root-01-01`。path 一律由 runtime 分配，模型不能自己传。三个身份分工明确：`agentPath` 是 run 内
的树位置（短、可读，用于提示词、文件名和树展示），`node.id` 是执行身份（`<runId>:<agentPath>`），
`skillId` 是长期唯一的 skill 身份（写进 frontmatter 和索引）。这不是洁癖：`root-01` 只在同一 run
内有效，跨 run 必然重名，拿它当长期引用键，归档三个月后就会开始互相覆盖。

### 2.3 归档目录：一次派发落几十个文件

每次派发都写进 workspace 的 `.webAgent-archive/`（已在 `.gitignore` 里）：

```text
.webAgent-archive/
  conversations/<conversationId>/runs/<runId>/
    run.json / events.jsonl      # run 元信息 + append-only 事件流（回放的唯一事实来源）
    tree.json / nodes/<path>.json # 最后一次树快照 + 每个节点独立快照
    results/<path>.result.md      # 子 agent 结果
    traces/<path>.trace.jsonl     # 子 agent 自己的模型对话
    skills/<path>-task_brief.md   # run-local skill，给人读
  skills/<skillId>.md             # 全局 skill store，长期引用
  index/{runs,agents,skills}.jsonl # 三条状态索引流
  governance/                     # 治理动作审计与事务 journal
```

关键约定：`events.jsonl` 是 append-only，永远不合批压缩、不被清理脚本删除；`index/*.jsonl` 是
状态流，同一 key 可以有多条记录，消费方取最后一条。**一条只增不改，一条允许压缩**——后面两个脚本
的分工就建立在这个区别上。

## 三、资产不能自己长大：预算与权限

递归委派最危险的是它会自己放大自己：一个子 agent 再派 6 个，两层就是 36 个模型调用起步。所以
`delegate_agent` 的输入在归一化阶段就被夹住（`packages/agent-core/src/subagents/input.ts`）：

| 预算项 | 默认 | 硬上限 | 作用范围 |
| --- | --- | --- | --- |
| `maxChildren` | 6 | 12 | 单批次子节点数 |
| `maxConcurrent` | 4 | 8 | 整棵树的模型请求并发 |
| `maxDepth` | 2 | 6 | 树深度 |
| `maxTotalNodes` | 64 | 256 | 整树节点数，含 root |
| `maxModelCalls` | 128 | 512 | 整树模型调用，含蒸馏 |

比数值更重要的是**单向性**：预算沿树只能收紧不能放宽，子 agent 在嵌套调用里写一个更大的
`maxChildren` 会被按 min 夹回去。`maxTotalNodes` 和 `maxModelCalls` 由整棵树共享计数，且在拿到
并发许可后、真正发请求前就计数，不给"先发出去再说"的窗口。

权限是同一个套路，一条全序能力阶梯 `delegate_only ⊂ workspace_read ⊂ workspace_verify`：默认
只能继续派发，`workspace_read` 加只读文件工具，`workspace_verify` 再加受限的验证命令工具，让
核验型子 agent 自己拿到执行证据——但仍不能写文件、拿不到通用 shell，后代只能继承或收紧。写类
危险工具则不走 profile，走逐次签发的 capability：同时绑定 sessionId、runId、本次 `delegate_agent`
的 call id 和父节点 path，四项独立校验；session 里"本次会话一律允许"的集合**不会**整体下放，
只有本次调用显式列出、且 session 已确认的交集才签发。最终生效的工具名写进归档事件。

## 四、五个运维问题，五个治理脚本

让"资产"这个说法站得住的，是归档落地之后还有人管它。仓库根 `package.json` 里有五个
`subagent:*` 脚本，每个解决一个具体的运维问题。

### 4.1 `pnpm subagent:replay`：出事了从哪查

对应 `scripts/subagent-replay-report.js`。输入 conversationId + runId（或直接指一个
`events.jsonl`），它读 `events.jsonl` 和 `tree.json`，把归档重建成可读报告或 JSON：

```bash
pnpm subagent:replay -- --conversation <conversationId> --run <runId> [--json]
```

输出五块：事件统计（按类型计数）、节点汇总（running/distilling/queued/done/failed/cancelled）、
节点树状态（每个 path 的状态、dispatch 次数、本地与继承 skills、result 文件）、子任务结果、解析
异常。最后一块值得单说：坏行不会让整个报告失败，而是带着行号和错误留在 `parseErrors` 里——排障
工具在数据本身有问题时崩掉，是最没用的时刻崩掉。回放逻辑在
`packages/subagents/src/archive/replay.ts`，CLI 只是宿主之一。

### 4.2 `pnpm subagent:capacity`：一棵满树到底多大

这条脚本跑的是 `packages/subagents/src/archive/archiveCapacity.test.ts`——它是**容量基线回归
测试**，不是运维报表。单独挂一个 script，是因为"归档会长多大"不能靠拍脑袋：一万条事件的长会话，
归档仍然只有 4 个文件、事件计数 10001；打满 256 节点硬上限的树是 262 个文件，归档总字节数确实
大于节点状态本身，差额就是审计成本；12 个 child 的批次，并发峰值被锁在 8。度量函数在
`packages/subagents/src/archive/archiveCapacity.ts`，带 `SUBAGENT_CAPACITY_REPORT=1` 可以打出
实测字节数。价值在于：改了归档格式、加了字段，容量影响会在 CI 上显形，而不是三个月后由磁盘告诉你。

### 4.3 `pnpm subagent:archive:retention`：归档无限增长

对应 `scripts/subagent-archive-retention.js`，解决"跑了半年，`.webAgent-archive/` 几个 G"。设计
原则是**默认只读、删除要有出口**：

```bash
pnpm subagent:archive:retention -- --max-bytes 524288000    # 只报告容量与可回收候选
pnpm subagent:archive:retention -- --prune --max-bytes 524288000 \
  --export ../subagent-retention-2026-08 --write            # 真正清理，导出目录必须在 archive 之外
```

几条硬约束值得抄：只接受已完成（`status: "delegated"`）的 run；先复制到外部目录并逐文件校验
SHA-256，再删除 live 侧的派生文件（`tree.json`、`nodes/`、`results/`、`traces/`、run-local
`skills/`）；`events.jsonl` 和 `run.json` 永远保留也永远不被覆盖；光删派生文件达不到目标阈值时
命令直接拒绝，而不是退而求其次去动事件流。`--restore` 只接受前面产出的导出包且拒绝覆盖已有文件，
所有 export/prune/restore 都 append 到 `governance/retention-actions.jsonl` 审计。

一句话概括：**可再生成的内容可以搬走，事实来源不许动。**

### 4.4 `pnpm subagent:index:compact`：索引膨胀

对应 `scripts/subagent-index-compact.js`。三条状态索引是 append-only 的状态流——同一个 run 从
`running` 到 `delegated` 会写多条，长期就是大量历史状态行。压缩即按逻辑 key 去重保留最新：run 用
`conversationId+runId`，agent 再加 `path`，skill 用 `skillId`。

```bash
pnpm subagent:index:compact            # 只报告去重计划
pnpm subagent:index:compact -- --write # 原子替换
```

同样默认只读；坏行中止全部写入而不是"跳过继续"；并且它**只处理 `index/*.jsonl`**，绝不读取或改写
`events.jsonl`。桌面宿主里还有一份自动压缩（`apps/desktop/src/workspace_write.rs`）：索引超过
128 KiB 触发、最多每 5 分钟一次、16 MiB 安全上限，与 CLI 共用同一套跨进程锁；CLI 用于手动兜底。

### 4.5 `pnpm subagent:skills`：蒸馏产物谁能转正

对应 `scripts/subagent-skill-governance.js`。派发前 runtime 会把父 agent 的思路和当前对话蒸馏成
skill，子 agent 继承父节点 skill 再叠加自己的任务简报。这些 skill 默认 `ttl: permanent` +
`promotion: candidate`：**长期归档，但不会自动变成全局常驻上下文**——自动把 agent 生成的内容变成
长期记忆，是上下文污染最快的路径。转正只接受人工显式操作：

```bash
pnpm subagent:skills [-- --json]                 # 默认只读列举 candidate
pnpm subagent:skills -- --promote sk_xxx --write # 变更必须给出 skillId 和 --write
pnpm subagent:skills -- --archive sk_xxx --write
```

只允许单向迁移 `candidate → promoted`、`candidate|promoted → archived`，不支持回退或重复迁移。
写入前完整解析索引并校验它与全局 skill frontmatter 的 `skill_id`、`promotion` 一致，任何坏行或
不一致都 fail-closed 不落盘。三文件变更走预写事务 journal（`governance/skill-transaction.json`），
中断后按状态幂等前滚或回滚，保证 `governance/skill-actions.jsonl` 里每个人工动作恰好一条。UI 会
对 candidate 做确定性评分并解释理由，但**确认按钮只生成上述审计 CLI，并标注"操作已生成，尚未
执行"**——事务锁、journal 和审计的唯一所有权留在治理脚本里。

## 五、观测配套：每一步都能回看

归档解决"跑完之后还剩什么"，观测解决"跑的过程中发生了什么"，是分开的两套设施：

- 主 run 的 trace 走可插拔观测 driver：Web 用 IndexedDB（`@web-agent/observability-idb`），
  Tauri 用 SQLite（`@web-agent/observability-sqlite`），UI 侧是 `apps/web/src/traceViewer/`。
- 子 agent 自己的模型对话落进归档的 `traces/<agentPath>.trace.jsonl`，UI 通过
  `packages/subagents/src/state/subagentTraceAtoms.ts` 按需读回——点开树上任意节点，看到的是它
  当时的完整来回，而不只是那句 summary。
- 归档写入本身也被观测：writer 关闭时旁路记录一条 `subagent.archive_write_summary` span，带写入
  尝试数、失败数和失败率——**治理设施自己也会坏，坏了得有人知道。**

于是开头那句"它为什么改错文件"有了确定查法：replay 定位失败节点的 path，再看该节点的 trace。

## 六、诚实的边界

这套东西目前有四个明确的"还不是"：

1. **五个脚本都是手动 CLI，不是自动后台任务。** 没有定时 GC、容量告警和自动转正；唯一自动化的是
   桌面宿主里的索引压缩。归档涨到多大要人自己去看，retention 也要人自己去跑。
2. **`subagent:capacity` 是回归测试，不是运维报表。** 它跑在内存 host 上，测序列化体积和并发上限
   这些确定性数字，不测真实磁盘 IO，也不反映你线上那个 workspace 现在多大。
3. **retention 只回收派生文件。** 事件流永远保留，长期占用仍单调增长，只是增速被压下来了。
4. **skill 转正必须人工。** 这是有意的，但也意味着 candidate 会持续堆积，需要有人定期看。

写出来是因为"治理"很容易被讲成"全自动"。实际状态是：**机制和审计已经齐了，调度还靠人。** 先把
事实留下来、把危险操作夹住，自动化才有可能是安全的；反过来先上自动清理，等于让一个没人看得懂的
系统自己删证据。

## 结语

产品里已经有子 agent 的话，拿这四个问题自检：三天前那次派发现在还能完整回放吗？一次派发最多能
消耗多少模型调用，这个上限写在代码里还是写在心里？子 agent 能不能通过递归把父 agent 的预算和
权限放大？归档目录多大，谁在管？答案基本决定了你的子 agent 是资产还是负债。

机制并不复杂——树形 path、只增的事件流、可压缩的索引、单向收紧的预算、默认只读的治理脚本——难的
是在加第一个子 agent 的时候就把它们一起加上，而不是等磁盘告警那天。
