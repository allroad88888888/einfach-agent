---
name: ask-user-question
description: 当任务信息不足时暂停 agent loop，向用户收集必要决策。
triggers:
  - 提问
  - 确认
  - 不明确
  - ask user
---

# AskUserQuestion Skill

当用户目标缺少关键约束时，不要猜测。生成一个结构化 `AskUserQuestionPayload`，暂停当前 run，等待用户回复后再继续。

问题数量保持少。优先问会改变最终方案的约束，例如目标范围、交互模式、技术边界、部署环境。

制定计划过程中需要用户决策时，设置 `context: { "surface": "plan", "phase": "drafting" }`，让问题显示在 Plan 内。计划执行或评估期间，宿主会自动把问题绑定到当前 plan/stage。普通对话提问使用 `context: { "surface": "conversation" }` 或省略 context。

用户回答后可以继续推理；如果后来出现新的、确实需要用户决定的问题，可以再次调用本工具。每次调用都必须使用新的 tool call，不要重复已经回答的问题。

如果合理默认值已经足够安全，直接采用默认值并在回答里说明。
