---
name: web-chat-agent
description: Web 端 chat agent 的最小运行时边界。
triggers:
  - web agent
  - chat
  - 前端
  - runtime
---

# Web Chat Agent Skill

第一版只保留 chat 体验、streaming、session state、skills、lazy tools 和 AskUserQuestion。

不包含文件系统、终端、Git、MCP、真实 Web search、HTTP request、长期记忆或复杂权限系统。

React UI 只负责渲染。产品状态使用 Einfach atoms，agent runtime 通过 store 写入状态。
