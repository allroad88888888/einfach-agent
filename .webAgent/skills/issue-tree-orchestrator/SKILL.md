---
name: issue-tree-orchestrator
description: Create and maintain a small tree-shaped local Markdown Issue before any repository-changing task, assign an available model to each leaf, and coordinate conflict-free parallel agents. Use for features, bug fixes, refactors, tests, documentation, investigations, or whenever the user asks to plan, create an issue, split work, assign models, or use multiple agents.
---

# Issue Tree Orchestrator

Create a local Issue before making repository changes. Treat the Issue as the execution contract: it records the goal, decisions, dependency graph, file ownership, model assignment, and completion evidence.

Do not create an Issue for a pure answer or read-only status report. Create one for any work that will change repository files, project configuration, tests, or documentation.

## Required workflow

1. Read applicable `AGENTS.md`, repository contribution guidance, and relevant existing architecture/docs.
2. Inspect the current worktree and find the project's existing local Issue or blueprint convention.
3. Create a new Markdown Issue before implementation. Reuse the project convention; if none exists, use `docs/issues/YYYY-MM-DD-<kebab-slug>.md`.
4. Break the work into leaf Issues small enough to assign, review, and verify independently. Give every leaf one primary responsibility and one owner model.
5. Record dependencies and the exact file/folder ownership for every implementation leaf. Do not schedule leaves together if their primary edit paths overlap.
6. Show the plan to the user when the request is planning-only or an unresolved product decision exists. Otherwise begin only the ready, independent leaves.
7. Run concurrent agents only for independent leaves and only up to the available concurrency limit. Keep integration, shared exports, and final verification with the coordinating agent unless a separate integration leaf owns them.
8. Update the Issue after each leaf with status, evidence, and any changed assumptions. Finish with an independent review leaf and a final integration/validation record.

## Issue format

Start every Issue with this compact header:

```markdown
# <Feature or task name>

状态：规划中 | 待批准 | 执行中 | 已完成 | 阻塞
创建日期：YYYY-MM-DD
协调者：<model>
范围：<one sentence>
非目标：<brief exclusions>
```

Then add these sections, in this order:

1. **目标与验收** — observable user behavior, constraints, and security/data boundaries.
2. **已确认决策 / 待确认项** — do not hide product decisions in implementation leaves.
3. **任务树** — hierarchical IDs (`KEY-GATE`, `KEY-GATE-10`, `KEY-GATE-10A`). Branch nodes coordinate; leaves are executable.
4. **叶子任务表** — one row per executable leaf:

   | ID | 责任 | Owner model | Primary files | Depends on | Done when | Status |
   | --- | --- | --- | --- | --- | --- |

5. **并发批次** — list only leaves that can run together and state why their files do not collide.
6. **验证与交付** — test commands, manual checks, independent review, and final commit/PR evidence when applicable.

Use a textual tree rather than a flat checklist, for example:

```text
KEY-GATE  启动模型密钥门禁
├─ KEY-GATE-00  定义启动目标解析契约
│  └─ KEY-GATE-00A  覆盖空会话、恢复会话与未知状态测试
├─ KEY-GATE-10  启动预检状态
│  ├─ KEY-GATE-10A  纯函数：会话 → 密钥目标
│  └─ KEY-GATE-10B  应用启动顺序与阻塞状态
├─ KEY-GATE-20  密钥输入门禁 UI
│  ├─ KEY-GATE-20A  可访问对话框骨架
│  └─ KEY-GATE-20B  写入后重新查询并放行
└─ KEY-GATE-90  独立回归与安全审查
```

## How to split work

Make leaves small by responsibility, not arbitrary line count. A leaf normally owns one of: a pure contract/resolver, a focused state transition, a UI component, a native boundary, a focused test suite, documentation, or independent review.

For each leaf, state the edit paths before assigning it. Shared assembly files (application entry points, public barrels, central registries, lockfiles, and generated artifacts) must have exactly one integration owner and are not parallel-edit targets. If two leaves need the same file, split the abstraction first or run them sequentially.

Keep test ownership explicit. A leaf may include the focused test for its own behavior; the final review leaf must remain separate from the implementation owner.

## Model assignment

Assign from the models available in the current environment. Prefer capability fit over filling every model slot:

| Work type | Preferred assignment |
| --- | --- |
| Cross-layer contracts, credentials/security, concurrency, integration | `gpt-5.6-sol` with high reasoning |
| Bounded UI, isolated modules, focused tests, docs | `gpt-5.6-terra` with medium reasoning |
| Mechanical, isolated edits after a stable contract exists | `gpt-5.6-luna` with medium reasoning |
| Independent final review | A model/task separate from the implementation owner; prefer `gpt-5.6-sol` for security-sensitive changes |

If a preferred model is unavailable, record the actual assigned model and reasoning level. Do not assign the same file to multiple agents merely to increase parallelism.

## Agent execution rules

Before spawning agents, confirm all of the following in the Issue:

- The leaf has no unresolved product decision.
- Its dependencies are complete or are available as a stable contract.
- Its primary file paths do not overlap with another active leaf.
- Its acceptance checks and return artifact are explicit.

Give each agent only its leaf ID, contract, owned paths, forbidden shared paths, and required checks. Require it to report its changed files and validation evidence. Do not ask agents to commit unless the parent Issue explicitly delegates commit ownership.

When a leaf discovers a new shared dependency, stop that leaf, update the tree, and reschedule rather than allowing conflicting edits. The coordinator integrates results, checks the combined diff, runs the agreed validation, and updates the Issue before committing.

## Completion gate

Mark the parent Issue complete only when every required leaf is complete, the final review reports no unresolved findings, validation evidence is recorded, and the worktree/commit state is stated accurately. If the user asked only for planning, leave the Issue at **待批准** and do not begin implementation.
