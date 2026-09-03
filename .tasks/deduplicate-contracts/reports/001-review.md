# 001 R1 独立复审

## 回执

**APPROVED** — 原 3 个 Important 与 2 个 Minor 均已关闭，未发现这些问题仍有残留。

## 复审边界

- 仅核对上一版审查列出的 3 个 Important 与 2 个 Minor。
- 依据更新后的执行报告、`git diff 55a3d2e -- packages/agent-core/src/subagents packages/subagents/src/archive` 及范围内新增文件进行静态复审。
- 按要求未重跑报告中的测试，未检查或修改范围外产品代码。

## Important 闭环

1. ✅ **unknown / malformed version 不再伪造成功。** `replay.ts` 在创建节点前解码 `child_started` / `child_finished`；带版本字段且解码失败的事件会写入可观察的 `parseErrors` 并 `continue`，不会创建 child 节点或生成默认 `done` 结果。v1 decoder 现在校验必填字段及全部可选字段，损坏的 `changeSets` 也会令整个 v1 payload 被拒绝。`replayChildPayload.test.ts` 同时断言未知版本与 malformed v1 均无 child result、无 child node，并产生对应错误。
2. ✅ **objective 优先级已落实为 finished → explicit snapshot → started。** snapshot parser 额外记录真正显式提供非空 objective 的路径；`child_started` 仅在该路径没有显式 snapshot objective 时写入 node，`child_finished` 仍可最终覆盖。结果构造使用 finished 后的 node objective，再退回 started。新增三路径用例分别覆盖 snapshot 胜 started、缺失 snapshot 时 started 补值、finished 胜 snapshot。
3. ✅ **真实 runtime producer → archive JSONL → replay 已覆盖非空 `changeSets`。** `runtime.archiveReplay.test.ts` 通过真实 delegation runtime 执行 child tool，获得非空 change set，从 archive writer 的 `events.jsonl` 取出终态事件并交给 replay，最终将 replay 结果与在线 child 的 `changeSets` 对比；同时断言实际终态 payload 带版本号。

## Minor 闭环

1. ✅ **蒸馏失败改为显式 wire projection。** `delegationBatch.ts` 不再把 `{ ...child }` 传给 codec，而是显式列出 status、objective、summary、skillFiles、skillIds、changeSets、error。对应 runtime 用例断言终态带 v1/version 与空 `changeSets`，且 `data` 不含重复的 `path`。
2. ✅ **version / malformed `changeSets` 回归保护已补齐。** 新测试直接覆盖 unsupported version、v1 中错误 `reversible` 类型的拒绝；真实 runtime 与蒸馏失败 producer 测试均断言 `child_payload_version: 1`。

## 测试声明

更新报告称相关 7 个测试文件、30 个测试全部通过；本次复审未重跑。报告中的范围外 `*.md?raw` TypeScript 错误与上述五项闭环无关。
