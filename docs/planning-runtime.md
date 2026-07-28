# Planning Runtime

Planning 是独立的执行阶段，不是 assistant 回复中的临时 Markdown。

## 协议

1. `create_plan` 创建结构化计划。阶段包含稳定 ID、可观察的目标、交付物和依赖。
2. `approvalMode: auto` 直接进入 `approved`；`required` 进入 `awaiting_approval`，并暂停当前 run。
3. 只有宿主 UI 的 `approvePlan` 命令能批准或拒绝。模型没有 approve tool，不能自批。
4. `execute_plan` 校验 plan ID 与 revision，然后把首个依赖就绪阶段切到 `in_progress`。
5. 模型使用普通工具或 `delegate_agent` 完成该阶段，再调用 `submit_stage_result` 提交摘要和可核验证据。
   该调用完成当前阶段并激活下一个依赖就绪阶段；最后一个阶段完成时计划进入 `completed`。
6. `update_plan` 只记录 `blocked`。目标确实达不成时走这条路径，而不是提交一份夸大的结果。
7. 计划结果由用户在对话中判断。运行时不做自动验收，也没有「待用户验收」状态。

## 自动触发

`planning` skill 会被显式关键词触发，也会被复杂度启发式触发，包括多模块、先后依赖、架构/迁移、并发 agent、实现加测试或文档等表达。system policy 还要求模型在执行中发现任务升级为多阶段时补建计划。

简单问答和单步可逆修改不应创建计划。用户明确要求先确认、存在重大选项、破坏性/外部可见/高成本或语义含糊时，必须使用 required approval。

## 状态与持久化

计划的运行时唯一状态源是每会话 Einfach `planAtom`。`SessionMeta.plan` 是落盘副本，启动 hydrate 时先迁移到 v4，再恢复到 `planAtom`；旧版 completed 计划保持完成，不会被追溯降级。

v4 移除了宿主评估：`acceptanceCriteria`、逐条判定、`evaluating` 状态和「待用户验收」都不再存在。迁移时评估结论被丢弃，最后一次提交的摘要与证据折叠进 `stage.result` 保留；中断在评估中的阶段回落 `in_progress`（当时没有人确认它做完了，判完成会把未验证的工作永久标成已完成）。

revision 使用乐观并发控制；依赖必须存在且无环；同一计划最多一个执行中的阶段；阶段完成必须带 summary 与 evidence；阻塞阶段必须有 blockReason。工具只能通过 `ToolContext` 的受限能力操作状态，不直接 import store 或 atom。

## 实现入口

- 数据结构与迁移：[`packages/agent-core/src/planning/types.ts`](../packages/agent-core/src/planning/types.ts)、
  [`migrate.ts`](../packages/agent-core/src/planning/migrate.ts)
- 计划状态机：[`packages/agent-core/src/planning/runtime.ts`](../packages/agent-core/src/planning/runtime.ts)
- 模型可调用工具：[`tools/planning/src`](../tools/planning/src)
- 宿主审批与命令：
  [`packages/agent-core/src/runtime/commands.ts`](../packages/agent-core/src/runtime/commands.ts)
- UI：[`apps/web/src/agentNew/ui/PlanPanel.tsx`](../apps/web/src/agentNew/ui/PlanPanel.tsx)

相关验证：

```bash
pnpm exec vitest run packages/agent-core/src/planning/runtime.test.ts
pnpm exec vitest run packages/agent-core/src/planning/migrate.test.ts
pnpm exec vitest run tools/planning/src/submit-stage-result/submit-stage-result.test.ts
```

> 多实例说明：默认应用路径使用 `defaultCore`。Planning 状态完全绑定独立 `CoreInstance` 仍在收口中，
> 在此之前不要把 `createCore()` 视作 Planning 已完全隔离；详见
> [项目路线图](ROADMAP.md#阶段-1core-多实例隔离收口)。
