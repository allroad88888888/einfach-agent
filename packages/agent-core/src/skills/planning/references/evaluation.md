# 评估准则详细说明

本资源是 planning skill 正文里「host 调用独立评估者判定 stage/plan」一句的展开，帮助你写出
真正可评估的 `acceptanceCriteria`、提交经得住核对的证据，并理解评估结果的结构。跳过本资源
不影响你使用 create_plan → execute_plan → submit_stage_result 的基本协议；正文已经包含协议
本身的全部关键信息，这里只补充「怎么写得更好」。

## acceptanceCriteria：如何写才可评估

`create_plan` 的每个 stage 必须提供非空、去重的 `acceptanceCriteria`（宿主在创建时校验，缺失
或重复会被直接拒绝）。好的验收标准是**可观察、可核对**的陈述，而不是目标的同义复述：

- 好：`pnpm exec vitest run packages/foo 全绿，新增 3 个用例覆盖边界情况`
- 好：`GET /api/users/:id 对不存在的 id 返回 404 而不是 500，错误码为 USER_NOT_FOUND`
- 差：`用户模块工作正常`（无法核对，评估者无从判断证据是否充分）
- 差：`代码质量提升`（没有可观察的验收信号）

一条标准只断言一件事；需要同时验证多件事时拆成多条，方便评估者逐条给出结论，也方便你逐条
准备证据。

## 独立评估者看到什么

`submit_stage_result` 提交后，宿主会针对当前 stage 的每一条 `acceptanceCriteria` 产出一条
`CriterionEvaluation`：

```ts
interface CriterionEvaluation {
  criterion: string           // 对应某条 acceptanceCriteria 原文
  status: 'passed' | 'failed' | 'unknown'
  evidence: string[]          // 评估者认定支撑该结论的证据
  reason: string              // 为什么给出这个 status
}
```

多次提交会累积成一轮又一轮的评估尝试，保留每轮的 summary、你提交的证据、评估结论与时间戳，
便于回头看清楚前几轮为什么没通过。

## 「all-passed」的含义

只有当该 stage **全部** `CriterionEvaluation.status === 'passed'` 时，stage 才算完成。任意
一条 `unknown`（证据不足、无法判断）或 `failed`（明确不满足）都会让 stage 停在待改进状态，需
要你补充证据或调整实现后再次 `submit_stage_result`——而不是自行宣称通过。整个 plan 在最后一个
stage 完成后，宿主还会做一轮 final integration / regression / original-goal 评估，同样遵循
「不自评、不自批、不代用户验收」的边界（正文已强调，这里不重复）。

## 提交证据的建议格式

`submit_stage_result` 的 `evidence` 是字符串数组，每条应该是评估者能独立核对的具体信号，而不
是复述结论：

- 命令 + 结果摘要：`pnpm exec vitest run tools/skills/ → 12 passed`
- 文件路径 + 关键行为：`tools/skills/src/skill-read/skill-read.ts:40 已支持 resource 参数`
- 逐条对照 `acceptanceCriteria` 原文给出对应证据，避免一条笼统证据糊住多条标准。

## 遇到无法达成的验收标准怎么办

不要静默跳过或自行放宽标准。当某条 `acceptanceCriteria` 确实无法满足（例如依赖被前置条件阻
塞），用 `update_plan` 把该 stage 标记为 `blocked` 并写明 `blockReason`，交由宿主/用户决定下
一步，而不是在 `submit_stage_result` 里回避该标准或假装满足。
