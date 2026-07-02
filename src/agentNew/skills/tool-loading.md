---
name: tool-loading
description: 工具只先暴露摘要，需要时再加载完整 schema。
triggers:
  - tool
  - 工具
  - 延迟加载
  - lazy loading
---

# Tool Loading Skill

默认上下文只包含工具摘要。只有在 agent 明确需要调用某个工具时，才读取完整 schema。

工具分三类：

- internal：runtime 内建动作，例如 AskUserQuestion。
- browser：由前端执行，例如把信息卡片渲染到对话流（browser_action 的 render_card）。
- server：后端工具，MVP 暂不启用。

本项目第一版不接真实外部工具。
