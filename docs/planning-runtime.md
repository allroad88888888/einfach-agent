# Planning Runtime

Planning 是独立的执行阶段，不是 assistant 回复中的临时 Markdown。

## 协议

1. `create_plan` 创建结构化计划。阶段包含稳定 ID、目标、交付物、验收标准和依赖。
2. `approvalMode: auto` 直接进入 `approved`；`required` 进入 `awaiting_approval`，并暂停当前 run。
3. 只有宿主 UI 的 `approvePlan` 命令能批准或拒绝。模型没有 approve tool，不能自批。
4. `execute_plan` 校验 plan ID 与 revision，然后把首个依赖就绪阶段切到 `in_progress`。
5. 模型使用普通工具或 `delegate_agent` 完成该阶段，再调用 `submit_stage_result` 提交摘要和可核验证据；提交只会把阶段置为 `evaluating`。
6. 宿主在该工具调用内启动独立、只读 evaluator 子 agent，逐条返回 `passed / failed / unknown`。评估工具不进入主模型 manifest，执行模型不能直接把阶段写成完成。
7. 只有全部验收标准通过，阶段才变为 `completed` 并激活下一阶段；失败或未知不会解锁依赖，可由 `execute_plan` 重试。
8. 最后阶段通过后自动执行整体验收，检查集成、回归与原始目标覆盖。通过后计划才完成；主观、外部可见或高风险结果进入 `awaiting_user_acceptance`，只能由宿主 UI 接受或拒绝。
9. `update_plan` 只记录 `blocked`。执行模型不能通过 completed/skipped 绕过 Evaluation。

## 自动触发

`planning` skill 会被显式关键词触发，也会被复杂度启发式触发，包括多模块、先后依赖、架构/迁移、并发 agent、实现加测试或文档等表达。system policy 还要求模型在执行中发现任务升级为多阶段时补建计划。

简单问答和单步可逆修改不应创建计划。用户明确要求先确认、存在重大选项、破坏性/外部可见/高成本或语义含糊时，必须使用 required approval。

## 状态与持久化

计划的运行时唯一状态源是每会话 Einfach `planAtom`。`SessionMeta.plan` 是落盘副本，启动 hydrate 时先迁移到 v2，再恢复到 `planAtom`；旧版 completed 计划保持完成，不会被追溯降级。工具只能通过 `ToolContext` 的受限能力操作状态，不直接 import store 或 atom。

revision 使用乐观并发控制；依赖必须存在且无环；同一计划最多一个执行或评估中的阶段；阶段完成必须有逐条 criterion evaluation；阻塞阶段必须有 blockReason。评估异常会 fail-closed，把阶段恢复为 `in_progress` 并留下 unknown 尝试记录，不会伪造成功。

## 实现入口

- 数据结构与迁移：[`packages/agent-core/src/planning/types.ts`](../packages/agent-core/src/planning/types.ts)、
  [`migrate.ts`](../packages/agent-core/src/planning/migrate.ts)
- 计划状态机：[`packages/agent-core/src/planning/runtime.ts`](../packages/agent-core/src/planning/runtime.ts)
- 独立评估：[`packages/agent-core/src/evaluation/runtime.ts`](../packages/agent-core/src/evaluation/runtime.ts)
- 模型可调用工具：[`tools/planning/src`](../tools/planning/src)
- 宿主审批与命令：
  [`packages/agent-core/src/runtime/commands.ts`](../packages/agent-core/src/runtime/commands.ts)
- UI：[`apps/web/src/agentNew/ui/PlanPanel.tsx`](../apps/web/src/agentNew/ui/PlanPanel.tsx)

相关验证：

```bash
pnpm exec vitest run packages/agent-core/src/planning/runtime.test.ts
pnpm exec vitest run packages/agent-core/src/evaluation/runtime.test.ts
pnpm exec vitest run tools/planning/src/submit-stage-result/submit-stage-result.test.ts
```

> 多实例说明：默认应用路径使用 `defaultCore`。Planning 状态完全绑定独立 `CoreInstance` 仍在收口中，
> 在此之前不要把 `createCore()` 视作 Planning 已完全隔离；详见
> [项目路线图](ROADMAP.md#阶段-1core-多实例隔离收口)。
