---
id: '290'
title: 撤销原话回到输入框且原位可重做
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/src/chat/
  - browser-agent/ui/src/BrowserAgentView.test.tsx
  - browser-agent/ui/README.md
---

用户最新反馈：undo 没有 redo，然后 undo 后应该把话放到输入框。沿用现有 tree 授权，不需确认。请独立实现此内聚修复，仅上述范围。仓库有大量未提交的既有工作，保留前态；reports/290-before/保存本次源文件前态，reports/290-prechange.diff保存相对HEAD前态。不得修改core，若真实问题必须core先报告证据给编排。

先读 CLAUDE.md、.project-lines/SKILL.md 及相关 UI/state 两线；应用 /Users/dol/.codex/skills/one-file-one-thing/SKILL.md，新/大改普通文件≤300，勿把当前约287行 BrowserAgentView.test.tsx再塞满；新集成用例独立为真实 undo/composer 行为文件。沿用已有 Apple 风格，不改大布局。

现状 ChatView.Conversation retract()仅调 core.retractTurn(userItemId,sessionId) 并反馈，无setDraft；ConversationTimeline.RetractedTurn 已投影retracted记录、按钮叫“恢复至本轮”。core有 sessionTurnHistoryAtom(sessionId)、retractTurn、restoreRetractedTurn，复用journal不能复制历史。BrowserAgentView.test.tsx有真实client+模拟fetch+显式session历史集成；chat/messageHistoryActions.test.tsx有目标行和禁用键盘测试。不要只做回调mock/改按钮名就宣称redo修好，要用真实core操作检查入口保留及恢复原结果。

验收：
- U01 成功撤销指定用户消息后，把该条原始文字（含换行/Unicode，不trim）放回输入框并聚焦；运行中撤销会stop并等textarea变可用后focus。失败/屏障时原草稿不被改。对本UI发送的字符串精确还原，若复用content parts，仅提取文本，不把JSON元数据放输入框。
- U02 已撤销原消息下明确可见且可键盘触发“重做”按钮；重做恢复至选定轮已有结果，不重跑模型/工具。全部撤销后仍有入口；中间撤销后多个入口各对应准确轮次。解释范围保留title即可，不加全局栏。
- U03 重做时只有仍未改动、且其来源轮已被恢复的自动回填草稿才清空；用户修改过的草稿保留。撤销后仅编辑草稿不销毁redo尾部，新发送才分支。避免过度封装，只维护临时回填来源（不是第二份history），禁止持久化新状态。
- U04 client/session切换保持原隔离、settings返回草稿保留；不靠当前全局session误操作。覆盖真实client集成，必要借已有测试即可，不重复不相关大测试。

验证 pnpm exec vitest run browser-agent/ui/src/ 与针对历史的core测试（如无core变更无需重跑所有core）；pnpm --filter @einfach-agent/browser-agent-ui build；pnpm --filter @einfach-agent/browser-extension build；pnpm exec tsc -b；node scripts/check-docs.js。不得pnpm install、访问钥匙串、发真实模型请求、浏览器/CDP、commit/push/远程issue；编排负责原生浏览器QA。extension上轮IIFE包隔离不可删，现有permissions不动。

报告只写reports/290-report.md：实际文件、根因与行为、验证命令结果、遗留。禁止改index或其他task，禁止派agent。
