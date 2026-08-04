# 上下文缓存成本 · 后续跟进项

> 配套文档：[上下文缓存成本治理](context-cache-cost.md)（账单归因、根因与已实施改动）、
> [Context Caching](context-caching.md)（契约）。
>
> 基线数据：2026-07-27。所有「当前值」都指这一天，验证时与之对比。

## 状态总览

| # | 项 | 状态 | 性价比 |
| --- | --- | --- | --- |
| F1 | 压缩投影复用的实测验证 | **本次验收通过**：6 次复用 / 2 次压缩 | 最高 |
| F2 | 空动态尾巴会话的 `history_inserted_before_dynamic_tail` 归零确认 | **已通过** | 低成本 |
| F3 | 会话过长的用户提示 | **已完成**：压缩前超过软上限时稳定提示 | 中 |
| F4 | 离线归因口径固化 | 已在文档固化，无需改码 | — |
| F5 | 跨 run 投影复用 | **已完成**：按会话 store 隔离的 WeakMap | 高 |
| F6 | 工具集增长步数的实测（schema 直接加载上线后） | **本次样本通过；schema 路径待观察** | 低成本 |
| C1 | `initial` 归因细化 | **已关闭**：正常行为 | — |
| C2 | 工具结果体积治理 | **已关闭**：不是瓶颈 | — |

F1 已由修复后的真实长会话通过；后续只需在日常使用中继续积累样本观察稳定性。

---

## F1 · 压缩投影复用的实测验证

**曾是最高优先**：改动已落地并通过全量测试，但当时**从未在真实会话里跑过**——改动完成时当天的
使用已经结束。下方的修复后复测已将当时基于 2026-07-27 trace 的收益推算转为真实证据。

**当前基线**：`compaction_projection_changed` 真实失效 114 次（232 次请求），涉及 16 个 run，
平均每 run 失效 7.1 次，最重的一个 run 失效 43 次。

### 2026-08-04 本机 trace 审计

修复前的历史样本最后停在 **2026-07-28 13:40:54**：有 988 条 `llm.context_snapshot`、53 个 run，
其中 2 条快照越过 20 万 token（最高 201,454）。但当前的跨 run 投影存活与动态尾巴隔离修复
`576044d`（2026-07-28 14:40:21）晚于它；其中的 189 次压缩和 3 次复用只能用于修复前诊断，
不能据此判定当前实现通过或不达标。

### 2026-08-04 11:05 后正式样本

用户完成一次 UI 长会话，界面最高显示 **108%**。按 `(run_id, llm_turn)` 只统计关联到成功
`llm.chat` 的事件：3 个 run、26 个请求、21 次 `llm.context_compacted`，仅 1 次
`llm.context_projection_reused`（`reuse_count` 最大 1），所以 **F1 不通过**。

根因不是缓存生命周期或前缀校验：每次压缩后投影仍在 169–172K，而有效预算只有 172,164 token；
下一轮通常追加 3–10K，预算复查必然拒绝复用并重新压缩。修复为：仅在已有投影缓存且已发生硬预算
溢出时，压到比真实请求预算低 24K 的目标；请求是否合规仍按原有效预算判断。该修复含回归测试，
修复后的收费真实会话复测见下节。

### 2026-08-04 11:34 修复后复测

同一类真实长会话共 8 个成功请求：`llm.context_compacted` 发生在第 1、8 轮（2 次），
`llm.context_projection_reused` 发生在第 2–7 轮（6 次，`reuse_count` 最大 6），因此 F1 的前三项
验收标准均通过。首轮投影为 148,055 token；第 7 轮累计追加 23,072 token 后仍能复用，第 8 轮超过
24K 余量才重新压缩到 146,478 token——这正是预留空间的预期边界，而不是回归。

界面显示的 **22%** 是第 8 轮的单次 Provider KV 命中率：重新压缩改写前缀后只会部分命中。第 2 轮
因 `tool.schema_autoloaded` 改变工具集也只有 1.26%；第 3–7 轮则为 **96.2%–98.3%**。按本次 8 个
请求的 hit/miss token 加权，Provider 命中率为 **68.86%**，高于 63.9% 的历史基线，F1 第四项也通过。
当前摘要栏刻意显示的是最新请求，不能把它当作整次 run 的累计命中率。

**做法**：正常使用 app 若干个长会话（至少要有会话越过 `COST_SOFT_CAP_TOKENS = 200_000` 触发
压缩，否则测不到东西），然后跑 [context-cache-cost.md 的验证 SQL](context-cache-cost.md#待验证)。
验收只统计能以 `(run_id, llm_turn)` 关联到 `status='ok'` 的 `llm.chat` 的 context 事件；取消或
供应商失败前已产生的投影事件只能说明尝试过，不得计入收益。

**验收标准**（缺一不可）：

1. 已关联到成功请求的 `llm.context_projection_reused` 条数显著多于
   `llm.context_compacted`；
2. `reuse_count` 的最大值 > 1，说明确实出现了「一次压缩摊多轮」；
3. 按 (scope, epoch) 去重后，`compaction_projection_changed` 的**真实失效次数**相对当轮压缩
   次数明显下降（理想形态：每个 run 只在首次触发压缩时失效一次）；
4. DeepSeek 账单侧 `ai-web` key 的命中率从 63.9% 回升。

**若不达标，按此顺序排查**：`reuse_count` 恒为 0 → 缓存没建起来（检查是不是每轮都走了
`compacted && withinBudget` 为假的分支）；`reuse_count` 有值但失效次数没降 → 复用被三道刹车
中的某一道频繁拒掉，逐个加日志确认是 append-only 校验、预算复查还是 CC3 兜底。

---

## F2 · 空动态尾巴会话的 `history_inserted_before_dynamic_tail` 归零确认

**现状**：该原因当天真实失效 **77 次、摊轮数 1.00**——即每一轮都失效，零复用，是所有原因里
唯一「完全没有复用」的一项。

**但它的钱不多**：变化点在历史**之后**（动态尾巴被后移的历史顶到新位置），前面的历史仍然命中，
每轮只 miss 尾巴那千把 token。483 轮撑死 ¥1.5。所以它是「次数刺眼、金额无关紧要」的一项，
不要因为 77 这个数字大就误判为重点。

**普通会话路径应该已经被修掉了**：稳定前缀组装把低频变更的 skill 清单、工具摘要、自定义指令从
动态尾巴移进历史之前；没有 plan/续跑/失败提示时，动态尾巴应为空。当天全部 77 次都发生在该改动
之前。

**不是全局归零指标**：当 plan 状态、续跑提醒或失败提醒确实存在时，后续历史插在这些尾巴之前是
正常请求投影变化，`history_inserted_before_dynamic_tail` 仍可能出现。这类样本不能与空尾巴样本混算。

**2026-08-04 结果**：24 个已成功关联、`dynamic_controls_count = 0` 的样本中，该原因是 **0**；
另有 2 个动态尾巴样本也为 0。F2 按既定口径通过。

---

## F3 · 会话过长的用户提示

**现状**：当天压缩前上下文均值 **35.9 万 token、峰值 61.6 万**，`COST_SOFT_CAP_TOKENS` 是 20 万。
即典型长会话要压掉一半以上内容才能发出去。

压缩本身是有损的（摘要工具结果、丢弃历史主干），并且投影复用只能让「压缩后的状态」稳定下来，
**并不能让被压掉的信息回来**。会话越长，每一轮携带的有效信息密度越低、成本越高。从产品角度，
及时开新会话比在压缩层继续优化更根本。

**当前只有**：`llm.context_over_budget` 事件里一句 `hint: '上下文压缩后仍超预算，建议开新会话'`，
只进 trace，UI 不可见——而且它只在**四级降级跑完仍超**时才发，那已经是最坏情况了。

**已实现**：`ContextStats` 在压缩前估算超过 `COST_SOFT_CAP_TOKENS` 时展示“建议新开会话”。
运行时把 `estimatedTokensBefore` 带进快照；投影复用轮仍会携带该值，因此预警是稳定文本而非每轮
弹出的提示。触发点取「压缩前估算 / `COST_SOFT_CAP_TOKENS`」而非 `over_budget` 事件——后者太晚。

**验收**：长会话在越过软上限后能在 UI 上看到提示，且提示不因每轮压缩而闪烁（按会话给一次，
或做节流）。

---

## F4 · 离线归因口径固化

**结论：只需文档固化，不必改代码。**

- **UI 侧口径本来就是对的**：`ContextStats` 展示的 `cacheTotals` 是按 **token** 累计的
  hit/miss/hitRate，且 `modelRun.ts` 只在 `profileId` 与 `epoch` 都相同时才继承上一次的累计值
  （epoch 一变就重新起算），与 `context-caching.md` 里「统计按当前 profile + epoch 聚合」一致。
- **风险只在离线 SQL 分析**：`cache_epoch_reason` 在 epoch 未推进时会沿用上一轮的值，所以数
  `llm.context_snapshot` 的**事件条数**会高估失效次数（当天 512 条记录 ↔ 263 次真实失效）。

正确口径与现成 SQL 已写进 [context-cache-cost.md](context-cache-cost.md) 的
「归因口径：按 (scope, epoch) 去重」一节。以后做类似分析先读那一节。

---

## F5 · 跨 run 投影复用

**已完成**：投影缓存以 `ctx.store` 为 WeakMap key；同一 core 的相邻 run 可复用，不会跨会话或
实例串用。drop 或 store 重建时缓存自然失效；每轮仍会复查 append-only、工具协议和 token 预算，
不满足条件即重新压缩，因此 checkpoint/revert 不会错误复用。

---

## F6 · 工具集增长步数的实测（schema 直接加载上线后）

**背景**：稳定前缀加上全量工具摘要后，模型拿到了精确工具名，于是常常跳过 `request_tool_schema`
直接指名道姓调用。原先这会撞上 lazy 闸门被拒、白烧一整轮（2026-07-27 实测：摘要上线后的两个
冷启动会话首轮工具调用 2/2 全被拒，上线前 402 次请求零发生）。现在闸门把这次调用**当作一次
加载请求**：装进 `visible`、下一轮起随 tools 长期携带，但本次不执行。

**与缓存的关系**：`toolSetFingerprint` 参与 `profileId`（`contextCache.ts`），所以**工具集每变一次
就是一次 `profile_changed` / 新 epoch / 整段前缀重读**。要盯的是「工具集变了几步」，不是「发了
几次请求」。

同一条轨迹上改动**不增加失效、净省**：

| | 改前 | 改后 |
| --- | --- | --- |
| turn1 | tools=[rts] → epoch 1 | tools=[rts] → epoch 1 |
| turn2 | tools 未变，只追加拒绝结果 → isPrefix 通过，不掉 epoch | tools=[rts,+3] → epoch 2 |
| turn3 | tools=[rts,+4] → epoch 2 | — |
| 合计 | 3 次请求，1 次失效 | **2 次请求，1 次失效** |

且历史里**永久**少掉每个工具一对「盲调 + 拒绝」条目，后续每一轮都跟着省。

**那么要验什么**：方向性风险——拒绝会逼模型停下来集中补课（22:18 那次一口气 load 了 4 个，其中
`skill_read` 是预判要用的），而就地加载让它边干边取，工具集可能变成**多次小步增长**，每一步都是
一次全量失效。已在 `toolSchemaAutoloadedResult` 的 hint 里留了「同一轮用 `request_tool_schema`
一并加载」的推荐，但这靠模型自觉，必须实测。

**做法**：与 F1 同一批长会话，在其 SQL 基础上加两段。工具集版本以
`tool_set_fingerprint` 为准，不能只数 `tools_count`：两个不同 schema 集合可能刚好有相同数量。
版本数包含 run 的初始工具集，因此「增长步数 = 版本数 - 1」。

```sql
-- ① 每个 run 的工具集版本数与增长步数（越小越好）。
--    只看能以 (run_id, llm_turn) 关联到成功 llm.chat 的快照；
--    <start_ms>/<end_ms> 与 F1 使用同一 [start, end) 采样窗口。
WITH completed AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn
  FROM trace_spans
  WHERE name = 'llm.chat' AND status = 'ok'
    AND started_at >= <start_ms> AND started_at < <end_ms>
), snapshots AS (
  SELECT e.run_id,
         json_extract(e.attrs, '$.tool_set_fingerprint') AS tool_set_fingerprint,
         CAST(json_extract(e.attrs, '$.tools_count') AS INTEGER) AS tools_count
  FROM trace_events e
  JOIN completed c ON c.run_id = e.run_id
    AND c.llm_turn = CAST(json_extract(e.attrs, '$.llm_turn') AS INTEGER)
  WHERE e.name = 'llm.context_snapshot'
    AND e.timestamp >= <start_ms> AND e.timestamp < <end_ms>
), per_run AS (
  SELECT run_id,
         COUNT(DISTINCT tool_set_fingerprint) AS 工具集版本数,
         MAX(tools_count) AS 最终工具数
  FROM snapshots
  GROUP BY run_id
)
SELECT run_id,
       工具集版本数 - 1 AS 工具集增长步数,
       工具集版本数,
       最终工具数
FROM per_run
ORDER BY 工具集版本数 DESC;

-- ② 就地加载 vs 显式加载的比例，以及是否还有硬拒绝。
--    tool schema 事件发生在一次已成功模型响应之后，但尚无 llm_turn 字段；
--    因此此处按同一 run 和时间窗口取样，不能把它和单次请求一一关联。
SELECT e.run_id, e.name, COUNT(*)
FROM trace_events e
WHERE e.name IN ('tool.schema_autoloaded', 'tool.schema_requested', 'tool.schema_not_loaded')
  AND e.timestamp >= <start_ms> AND e.timestamp < <end_ms>
GROUP BY e.run_id, e.name;
```

**改动前基线**（2026-07-27 19:02 之后、即工具摘要已上线但闸门尚未改的 16 个 run）：
工具集版本数**均值 1.94、最大 9**；`tool.schema_not_loaded` 8 次、`tool.schema_requested` 63 次。

**验收标准**：

1. `tool.schema_not_loaded` 在冷启动会话里归零（只剩幻觉工具名与 web 下的 server 工具这两类
   真·不可加载的情况）；
2. 工具集版本数均值不高于 1.94、最大值不高于 9（增长步数则各减 1）——**这是本项的核心指标**；
3. 按 (scope, epoch) 去重后，`profile_changed` 的真实失效次数没有相对上升。

**2026-08-04 结果**：3 个 run 各只有一个 `tool_set_fingerprint`，零变化、零转场；本次样本按
「增长步数不高于基线」通过。该样本未触发 schema 直接加载路径，冷启动硬拒绝的指标继续随该路径
出现时观察。

**若第 2 条不达标**（步数明显变多）：说明就地加载确实让模型放弃了批量补课。候选对策按代价从低
到高：加强 hint 措辞 → 在首轮 system 里显式要求「一次性列出本任务需要的全部工具」→ 对冷启动
首轮做一次小批量预载（子 agent 侧已经是这个做法，见 `subagents/runtime.ts` 的授权集预载）。

---

## 已关闭项

保留结论以免重复排查。

### C1 · `initial` 归因细化 —— 正常行为，无需优化

曾怀疑 `initial` 占 25.6%（131 次）里混有「本可避免的 profile 抖动」。查清了：131 次请求只对应
**45 个不同的 `cache_lane_scope_fingerprint`**，即 45 个 run 各一次起点，其余 86 次是同一 epoch
内沿用 reason 的正常复用轮（见 F4 的口径说明）。每个 run 一次 `initial` 是设计使然，无从优化。

### C2 · 工具结果体积治理 —— 不是瓶颈

曾判断「每轮未命中 5.75 万 token 里相当部分是 `read_file` / `rg_search` 的首发正文，应从源头压」。
**这个判断是错的**：run 内相邻轮的 `messages_chars` 差分显示典型轮次新增仅 **5,811 字符
（≈1.5K token）**，392 个样本里只有 1 轮超过 10 万字符。未命中的 5.75 万 token 里约 97% 是前缀
失效的重复付费，不是新内容。

工具结果体积治理（`read_file` 按行寻址等）作为上下文质量改进仍然有价值，但**不要把它当成本
优化手段**——按当天数据，即使把新增内容压到零，也只能省下约 ¥2。

> 若某天 SQL ④（每轮新增字符）的均值出现数量级上涨，本项需要重新打开。
