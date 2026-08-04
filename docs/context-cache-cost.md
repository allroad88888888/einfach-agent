# 上下文缓存成本治理

> 状态：投影复用已实现，**收益待实测验证**；剩余项见文末清单。
>
> 起点数据：2026-07-27 DeepSeek 账单 ¥87.51，其中 `ai-web` key 的 `deepseek-v4-pro` 占 ¥86.75。

## 为什么单开一份文档

[Context Caching](context-caching.md) 是**契约**文档，回答「缓存该怎么用」。本文是**成本治理**的跟进
记录，回答「钱花在哪、已经做了什么、下一步验什么」。归因方法本身是可复现资产——下次账单异常时
照着跑一遍即可，不必重新推导。

## 结论先行（2026-07-27）

成本一边倒地集中在一处：

| 成本项 | 金额 | 占比 |
| --- | --- | --- |
| `ai-web` / pro / **cache_miss 输入** | ¥83.33 | **95.2%** |
| `ai-web` / pro / output | ¥2.20 | 2.5% |
| `ai-web` / pro / cache_hit 输入 | ¥1.23 | 1.4% |
| 其余（`memory` key 的 evals 全部调用在内） | ¥0.75 | 0.9% |

`cache_hit` 与 `cache_miss` 的输入单价差 **120 倍**（¥0.025/M vs ¥3/M）。当天 7700 万输入 token
若全命中只需 ¥1.93，实际因 36% 未命中付了 ¥83。**命中率是唯一的成本杠杆**，输出和请求数都不是。

命中率不是均匀退化，而是被一个结构性原因压住的（见下节）：

| 日期 | 请求 | 每轮命中 | 每轮未命中 | 命中率 | ¥/请求 |
| --- | --- | --- | --- | --- | --- |
| 07-23 | 941 | 93.4K | 35.3K | 72.6% | 0.111 |
| 07-24 | 188 | 55.0K | 22.9K | 70.6% | 0.073 |
| 07-27 | 483 | 102.0K | 57.5K | 63.9% | 0.180 |

### 未命中 ≠ 新内容（口径修正，别再踩）

每轮 5.75 万 token 的未命中，第一反应容易解读成「每轮新增了这么多内容」，进而把优化方向指向
「压工具结果体积」。**这个解读是错的**，trace 侧实测否定了它：run 内相邻轮的 `messages_chars`
差分显示，典型轮次新增仅 **5,811 字符（≈1.5K token）**，392 个样本里只有 1 轮超过 10 万字符。

也就是说每轮 5.75 万 token 的未命中里，约 1.5K 是不可避免的新内容首发，**其余约 97% 是前缀
失效造成的重复付费**。折算 483 次请求 × 5.6 万 token × ¥3/M ≈ ¥81，几乎就是当天的全部成本。
结论：**成本问题是纯粹的缓存失效问题**，不是内容体积问题。

## 根因：压缩投影每轮重算

### 归因口径：按 (scope, epoch) 去重，不要数事件条数

`cache_epoch_reason` 在 epoch **未推进**时会沿用上一轮的值，所以一条 `llm.context_snapshot`
记录并不等于一次新失效——数事件条数会高估。正确口径是按
`cache_lane_scope_fingerprint + cache_epoch` 去重。当天 512 次请求（全部 `main` lane）：

| 失效原因 | 请求数 | **真实失效次数** | 每次失效摊几轮 | 请求涉及 token |
| --- | --- | --- | --- | --- |
| **`compaction_projection_changed`** | 232 | **114** | 2.04 | 39.5M |
| `history_inserted_before_dynamic_tail` | 77 | **77** | **1.00** | 7.5M |
| `initial`（新 run 起点，正常） | 131 | 45 | 2.91 | 18.7M |
| `dynamic_control_changed` | 36 | 16 | 2.25 | 3.6M |
| `profile_changed`（工具集变化） | 36 | 13 | 2.77 | 4.5M |
| 合计 | 512 | 263 | 1.95 | 73.8M |

两个要点：

- **epoch 失效 ≠ 全量 miss**。epoch 只是本地诊断标签，实际 miss 量取决于**变化点的位置**：
  `compaction_projection_changed` 改写的是历史中间段，从压缩点往后全 miss（成本大头）；
  `history_inserted_before_dynamic_tail` 的变化点在历史**之后**，前面的历史仍能命中，
  每轮只 miss 尾巴那千把 token（次数虽多，钱不多）。
- `initial` 131 次请求只对应 **45 个 scope**（= 45 个 run），即每个 run 一次起点、其余是同
  epoch 内的正常复用轮。**这项无需优化**，曾一度被误列为待查项。

`compactContext` 是纯函数，每轮拿当轮完整 items 从头重算；items 每轮追加，保护窗口与单元切分点
整体后移，投影逐字不同 —— 对 provider 的前缀缓存等于每轮换一个 prompt。单个会话的 epoch 轨迹
把这件事暴露得最清楚：

```
epoch  1  initial                                92 次请求   154K tok
epoch  2  history_inserted_before_dynamic_tail   58 次请求   163K
epoch  3  profile_changed                        28 次请求   157K
...
epoch 19  compaction_projection_changed           1 次请求   175K   ← 越过压缩线
epoch 20  compaction_projection_changed           1 次请求   175K
...      一直到 epoch 27，每个 epoch 都只有 1 次请求
```

压缩线**之前**一个 epoch 能撑 28~92 次请求；越过之后每个 epoch 只剩 1 次，即每轮 17.5 万 token
全额 miss、零复用。当天 281 次请求触发压缩，压缩前均值 35.9 万 token、峰值 61.6 万。

两个曾被怀疑但**不是**主因的方向，一并记下以免重复排查：

- **lazy tool schema 加载**（`profile_changed`）只占 7.0%。`buildTurnTools` 已按名称稳定排序、
  `canonicalizeJsonSchema` 递归排序键名，无变化时字节完全稳定；只有真加载新 schema 时才变，
  是按需而非每轮。这是 TK3 的设计取舍，不是缺陷。
- **`history_inserted_before_dynamic_tail`** 占 15.0%，量级只有每轮千把 token（skill 清单 +
  自定义指令），483 轮撑死 ¥1.5。它已被稳定前缀重排修掉（见 `modelRun.ts` 的 `stablePrefix`），
  但**解释不了 ¥83**。

## 已实施：压缩投影复用

契约与正确性论证写在 [Context Caching → 压缩投影复用](context-caching.md#压缩投影复用)，此处
不重复。要点：一次真压缩的产物在后续 append-only 轮次里直接复用，三道刹车（append-only 引用
校验 / 每轮预算复查 / CC3 tool 协议兜底）任意一条不成立就回落完整压缩；缓存 per-run。

实现与测试：

- `packages/agent-core/src/runtime/core/plugins/compactionPlugin.ts`
- `packages/agent-core/src/runtime/core/plugins/compactionPlugin.test.ts`（复用命中、连续多轮、
  revert、历史变短、预算撑爆、孤儿 tool、压完仍超不缓存、未压缩不缓存、不传 cache 逐轮重压）

**预估收益（上界）**：232 次压缩失效只涉及 **16 个 run**，平均每 run 失效 14.5 次，最重的一个
run 失效 43 次。每个 run 改后只压首轮，可消除 36.7M / 39.5M = **92.9%** 的失效量。按当天折算
理论上界约 ¥77；实际受「新增内容撑爆预算仍需重压」限制，保守估计 60~70%。

## 待验证

改动落地后**尚未有真实运行数据**（改动完成于当天 21:20 之后，此后未跑过 app）。下次使用后按
以下步骤确认。

Tauri 端 trace 落在 SQLite（macOS 路径如下，其他平台取对应的 Tauri app data dir）：

```
~/Library/Application Support/com.webagent.app/web-agent.db
```

⚠️ app 运行中该库有活动 WAL，**先复制一份再查**，不要直接在活动库上操作。

```sql
-- ① 完成请求上的复用与供应商命中：只统计能与 status='ok' 的 llm.chat
--    以 (run_id, llm_turn) 关联的 context 事件；避免取消或失败请求污染结论。
--    把 <start_ms>/<end_ms> 替换为当前桌面构建采样的 [start, end) 毫秒范围。
WITH completed AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn,
         json_extract(attrs, '$.cache_metrics_status') AS cache_metrics_status,
         CAST(json_extract(attrs, '$.cache_hit_tk') AS INTEGER) AS cache_hit_tk,
         CAST(json_extract(attrs, '$.cache_miss_tk') AS INTEGER) AS cache_miss_tk
  FROM trace_spans
  WHERE name = 'llm.chat' AND status = 'ok'
    AND started_at >= <start_ms> AND started_at < <end_ms>
), projection_events AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn,
         name
  FROM trace_events
  WHERE name IN ('llm.context_compacted', 'llm.context_projection_reused')
    AND timestamp >= <start_ms> AND timestamp < <end_ms>
)
SELECT p.name,
       COUNT(*) AS 已关联成功请求数,
       SUM(c.cache_metrics_status = 'available') AS 有供应商缓存指标数,
       COALESCE(SUM(c.cache_hit_tk), 0) AS 供应商命中token,
       COALESCE(SUM(c.cache_miss_tk), 0) AS 供应商未命中token
FROM projection_events p
JOIN completed c ON c.run_id = p.run_id AND c.llm_turn = p.llm_turn
GROUP BY p.name;

-- ② 一次压缩摊了几轮：看成功请求上的 reuse_count 最大值与分布
WITH completed AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn
  FROM trace_spans
  WHERE name = 'llm.chat' AND status = 'ok'
    AND started_at >= <start_ms> AND started_at < <end_ms>
)
SELECT MAX(json_extract(attrs, '$.reuse_count')) AS 最大摊轮数,
       ROUND(AVG(json_extract(attrs, '$.reuse_count'))) AS 均值
FROM trace_events e
JOIN completed c ON c.run_id = e.run_id
  AND c.llm_turn = CAST(json_extract(e.attrs, '$.llm_turn') AS INTEGER)
WHERE e.name = 'llm.context_projection_reused'
  AND e.timestamp >= <start_ms> AND e.timestamp < <end_ms>;

-- ③ 失效归因是否下降：按 (scope, epoch) 去重，compaction_projection_changed 应从 114 次明显回落
WITH completed AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn
  FROM trace_spans
  WHERE name = 'llm.chat' AND status = 'ok'
    AND started_at >= <start_ms> AND started_at < <end_ms>
), s AS (
  SELECT json_extract(e.attrs, '$.cache_lane_scope_fingerprint') scope,
         json_extract(e.attrs, '$.cache_epoch')                  epoch,
         json_extract(e.attrs, '$.cache_epoch_reason')           reason,
         CAST(json_extract(e.attrs, '$.dynamic_controls_count') AS INTEGER) AS dynamic_controls_count
  FROM trace_events e
  JOIN completed c ON c.run_id = e.run_id
    AND c.llm_turn = CAST(json_extract(e.attrs, '$.llm_turn') AS INTEGER)
  WHERE e.name = 'llm.context_snapshot'
    AND e.timestamp >= <start_ms> AND e.timestamp < <end_ms>)
SELECT dynamic_controls_count AS 动态尾巴条数,
       reason,
       COUNT(*)                              AS 请求数,
       COUNT(DISTINCT scope || '#' || epoch) AS 真实失效次数,
       ROUND(1.0 * COUNT(*) / COUNT(DISTINCT scope || '#' || epoch), 2) AS 摊轮数
FROM s GROUP BY dynamic_controls_count, reason ORDER BY 真实失效次数 DESC;

-- ④ 每轮真实新增内容（确认「未命中 ≠ 新内容」这一口径仍成立）
WITH completed AS (
  SELECT run_id,
         CAST(json_extract(attrs, '$.llm_turn') AS INTEGER) AS llm_turn
  FROM trace_spans
  WHERE name = 'llm.chat' AND status = 'ok'
    AND started_at >= <start_ms> AND started_at < <end_ms>
), s AS (
  SELECT e.run_id r,
         json_extract(e.attrs, '$.messages_chars') mc, e.timestamp ts
  FROM trace_events e
  JOIN completed c ON c.run_id = e.run_id
    AND c.llm_turn = CAST(json_extract(e.attrs, '$.llm_turn') AS INTEGER)
  WHERE e.name = 'llm.context_snapshot'
    AND e.timestamp >= <start_ms> AND e.timestamp < <end_ms>)
SELECT ROUND(AVG(d)) AS 每轮新增字符均值, ROUND(MAX(d)) AS 峰值
FROM (SELECT mc - LAG(mc) OVER (PARTITION BY r ORDER BY ts) d FROM s)
WHERE d IS NOT NULL AND d > 0;
```

账单侧对账：DeepSeek 控制台导出用量 CSV（`amount-*.csv` 有 `api_key_name` 维度，
`cost-*.csv` 是按模型的金额）。关注 `ai-web` key 的 `input_cache_hit_tokens` /
`input_cache_miss_tokens` 比值 —— 命中率应从 63.9% 回升。`memory` key 是 evals harness 用的，
金额可忽略，但它天然是「短 prompt、固定 fixture」的对照组。

## 剩余未解决项

已拆成独立的跟进清单（含每项的证据、方案、验收标准与已关闭项的结论）：
**[上下文缓存成本 · 后续跟进项](context-cache-followups.md)**。

## 关联

- 契约：[Context Caching](context-caching.md)
- 压缩策略本体：`packages/agent-core/src/runtime/contextCompaction.ts`（CC1~CC5、L1~L4 降级）
- 请求组装与稳定前缀：`packages/agent-core/src/runtime/modelRun.ts`（`stablePrefix`）
- 失效归因 tracker：`packages/agent-core/src/runtime/contextCache.ts`
- UI 入口：`apps/web/src/agentNew/ui/ContextStats.tsx`
