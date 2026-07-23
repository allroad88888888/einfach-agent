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

如果合理默认值已经足够安全，直接采用默认值并在回答里说明。
