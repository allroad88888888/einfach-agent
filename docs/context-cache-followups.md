# 上下文缓存成本 · 后续跟进项

> 配套文档：[上下文缓存成本治理](context-cache-cost.md)（账单归因、根因与已实施改动）、
> [Context Caching](context-caching.md)（契约）。
>
> 基线数据：2026-07-27。所有「当前值」都指这一天，验证时与之对比。

## 状态总览

| # | 项 | 状态 | 性价比 |
| --- | --- | --- | --- |
| F1 | 压缩投影复用的实测验证 | **待做（最高优先）** | — |
| F2 | `history_inserted_before_dynamic_tail` 归零确认 | 待做 | 低成本 |
| F3 | 会话过长的用户提示 | 待做 | 中 |
| F4 | 离线归因口径固化 | 已在文档固化，无需改码 | — |
| F5 | 跨 run 投影复用 | **暂不做**（理由见下） | 负 |
| F6 | 工具集增长步数的实测（schema 直接加载上线后） | 待做 | 低成本 |
| C1 | `initial` 归因细化 | **已关闭**：正常行为 | — |
| C2 | 工具结果体积治理 | **已关闭**：不是瓶颈 | — |

先做 F1。在拿到复用的真实数据之前，F3/F5 的收益都无法估准，容易做无用功。
F6 与 F1 用同一批会话、同一套 SQL，顺手一起验即可。

---

## F1 · 压缩投影复用的实测验证

**为什么最高优先**：改动已落地并通过全量测试，但**从未在真实会话里跑过**——改动完成时当天的
使用已经结束。所有收益数字目前都是基于 2026-07-27 trace 的推算，未经证实。

**当前基线**：`compaction_projection_changed` 真实失效 114 次（232 次请求），涉及 16 个 run，
平均每 run 失效 7.1 次，最重的一个 run 失效 43 次。

### 2026-08-04 本机 trace 审计

以 SQLite 只读聚合检查到的最后一条事件是 **2026-07-28 13:40:54**。当天虽有 988 条
`llm.context_snapshot`、53 个 run，且有 2 条快照越过 20 万 token（最高 201,454），但不能作为
F1 的验收样本：当前的跨 run 投影存活与动态尾巴隔离修复是 `576044d`
（2026-07-28 14:40:21）才落地，晚于全部现存 trace。该旧样本中的 189 次压缩和 3 次复用只可
作为修复前诊断，不能据此判定当前实现不达标或已通过。下一次采样必须来自包含 `576044d` 的桌面
构建，并继续按本节的验收 SQL 统计。

**同日增量采样（最后事件 09:23:05）**：当前桌面库新增的两个
`llm.context_snapshot` 都只有 1,681 `estimated_tokens`，没有任何压缩或投影复用事件；两个
run 的 `cache_epoch_reason` 都是 `initial`，工具集均为 1 个。这只能证明短请求的初始路径可用，
不能用于 F1、F2 或 F6 的结论；仍需在包含当前修复的桌面构建中完成至少一个越过 200,000 token
软上限的真实长会话。

**做法**：正常使用 app 若干个长会话（至少要有会话越过 `COST_SOFT_CAP_TOKENS = 200_000` 触发
压缩，否则测不到东西），然后跑 [context-cache-cost.md 的验证 SQL](context-cache-cost.md#待验证)。

**验收标准**（缺一不可）：

1. `llm.context_projection_reused` 条数显著多于 `llm.context_compacted`；
2. `reuse_count` 的最大值 > 1，说明确实出现了「一次压缩摊多轮」；
3. 按 (scope, epoch) 去重后，`compaction_projection_changed` 的**真实失效次数**相对当轮压缩
   次数明显下降（理想形态：每个 run 只在首次触发压缩时失效一次）；
4. DeepSeek 账单侧 `ai-web` key 的命中率从 63.9% 回升。

**若不达标，按此顺序排查**：`reuse_count` 恒为 0 → 缓存没建起来（检查是不是每轮都走了
`compacted && withinBudget` 为假的分支）；`reuse_count` 有值但失效次数没降 → 复用被三道刹车
中的某一道频繁拒掉，逐个加日志确认是 append-only 校验、预算复查还是 CC3 兜底。

---

## F2 · `history_inserted_before_dynamic_tail` 归零确认

**现状**：该原因当天真实失效 **77 次、摊轮数 1.00**——即每一轮都失效，零复用，是所有原因里
唯一「完全没有复用」的一项。

**但它的钱不多**：变化点在历史**之后**（动态尾巴被后移的历史顶到新位置），前面的历史仍然命中，
每轮只 miss 尾巴那千把 token。483 轮撑死 ¥1.5。所以它是「次数刺眼、金额无关紧要」的一项，
不要因为 77 这个数字大就误判为重点。

**它应该已经被修掉了**：`modelRun.ts` 的稳定前缀重排把低频变更的 skill 清单、工具摘要、自定义
指令从动态尾巴移进了 `stablePrefix`（历史之前），动态尾巴只剩事件驱动项。当天全部 77 次都发生
在该改动之前。

**做法**：F1 的验证 SQL ③ 已经覆盖，看这一行是否归零即可。**如果没归零**，说明还有别的常驻项
挂在历史之后，用 `dynamic_control_changed` 的伴随情况定位是 plan 状态、续跑提醒还是失败提醒。

---

## F3 · 会话过长的用户提示

**现状**：当天压缩前上下文均值 **35.9 万 token、峰值 61.6 万**，`COST_SOFT_CAP_TOKENS` 是 20 万。
即典型长会话要压掉一半以上内容才能发出去。

压缩本身是有损的（摘要工具结果、丢弃历史主干），并且投影复用只能让「压缩后的状态」稳定下来，
**并不能让被压掉的信息回来**。会话越长，每一轮携带的有效信息密度越低、成本越高。从产品角度，
及时开新会话比在压缩层继续优化更根本。

**当前只有**：`llm.context_over_budget` 事件里一句 `hint: '上下文压缩后仍超预算，建议开新会话'`，
只进 trace，UI 不可见——而且它只在**四级降级跑完仍超**时才发，那已经是最坏情况了。

**做法**：在 `ContextStats` 里加一档可见的预警。触发点建议取「压缩前估算 / `COST_SOFT_CAP_TOKENS`」
的比值而非 `over_budget` 事件——后者太晚。`ContextStats.tsx` 已经拿得到 `stats.cache` 与
`cacheTotals`，缺的是压缩前的量，需要把 `estimatedTokensBefore` 一并带进快照。

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

## F5 · 跨 run 投影复用（暂不做）

**现状**：投影缓存挂在插件闭包上 = per-run（`runToolLoop` 每个 run 装配一次插件）。跨 run
（用户发下一条消息）缓存丢失，必然重压一次。当天 16 个涉及压缩的 run，即最多 16 次重压。

**为什么暂不做**：

- **收益有上限且不大**。F1 落地后，每个 run 内的失效已收敛到 ~1 次；跨 run 复用最多再省下
  这 16 次里的一部分，相对 114 次的基线是零头。
- **风险显著更高**。跨 run 复用要把缓存挪到 per-session，就必须与 items 的 revert / checkpoint
  回滚生命周期对账。当前 per-run 方案能用「逐条引用比较」这一条极简判据兜住所有失效场景，
  正是因为 run 内 items 只增不改；跨 run 则要正面处理回滚，判据复杂度和出错面都上一个台阶。
- **跨 run 重压本身有正当性**。跨 run 必然有新的用户输入，`keepRecentTurns` 的保护窗口本就
  应该借这个机会重新取景——一直复用旧投影反而会让「最近若干轮保持原文」的语义长期失效。

**重新评估的触发条件**：F1 实测后，若发现跨 run 重压占剩余失效的多数（例如短 run 密集的
交互式使用模式下，16 次重压占了失效的大头），再回来考虑。

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

**做法**：与 F1 同一批长会话，在其 SQL 基础上加两段——

```sql
-- ① 每个 run 的工具集变了几步（越小越好）
SELECT run_id, COUNT(DISTINCT json_extract(attrs,'$.tools_count')) AS 工具集步数,
       MAX(json_extract(attrs,'$.tools_count')) AS 最终工具数
FROM trace_events WHERE name='llm.context_snapshot' GROUP BY run_id ORDER BY 工具集步数 DESC;

-- ② 就地加载 vs 显式加载的比例，以及是否还有硬拒绝
SELECT name, COUNT(*) FROM trace_events
WHERE name IN ('tool.schema_autoloaded','tool.schema_requested','tool.schema_not_loaded')
GROUP BY name;
```

**改动前基线**（2026-07-27 19:02 之后、即工具摘要已上线但闸门尚未改的 16 个 run）：
工具集步数**均值 1.94、最大 9**；`tool.schema_not_loaded` 8 次、`tool.schema_requested` 63 次。

**验收标准**：

1. `tool.schema_not_loaded` 在冷启动会话里归零（只剩幻觉工具名与 web 下的 server 工具这两类
   真·不可加载的情况）；
2. 工具集步数均值不高于 1.94、最大值不高于 9——**这是本项的核心指标**；
3. 按 (scope, epoch) 去重后，`profile_changed` 的真实失效次数没有相对上升。

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
