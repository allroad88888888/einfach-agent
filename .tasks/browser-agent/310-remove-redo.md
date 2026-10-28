---
id: '310'
title: 对话移除重做而保留撤销回填
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-terra
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/src/chat/
  - browser-agent/ui/src/BrowserAgentView.test.tsx
  - browser-agent/ui/src/styles/conversation.css
---

用户最新指令“重做功能移除”，覆盖290要求重做。沿用已有tree直接做本小型删减，不改变core公共日志/undo/redo合同；范围是浏览器产品对话功能。保留撤销后原话精确回填和焦点，以及隔离/不可逆屏障/运行停止能力。撤销记录不再留无用占位（原本为重做而设），消息从对话消失、原话进入输入框供修改发送。

按以下明确删减方案实施：
1. ChatView删除restore handler、onRestore传参、refilledFrom状态、重做后自动清草稿effect及相关setRefilledFrom、专属refusal文案；保留composerRef/focusWhenReady。焦点effect改为每次render后检查focusWhenReady.current且!busy，仅为成功撤销置true；不用数组依赖可以覆盖连续相同文字撤销导致draft未变。不要保留redo专属来源状态。
2. ConversationTimeline删onRestore prop、retracted数组与RetractedTurn渲染/组件、RedoIcon；只基于真实timeline.length判断空态，active消息沿用turnHistory map绑定精确undo。conversation.css删is-retracted两条专用样式。
3. 现有测试适配新行为：messageHistoryActions retracted应不渲染旧消息/redo且有空态；BrowserAgentView双会话用例仍检查undo隔离/原话回填，删restore步骤但保留recovery测试；undoComposerRedo.test.tsx重命名undoComposer.test.tsx并删redo用例，保留精确回填/没有重做或占位/运行中focus/两条同文本连续undo focus/拒绝时草稿保留。用真实已发送多轮测试，中间不调用redo，重试拒绝可独立重新发送一轮建立有效用户记录。只更新必要现有测试，不另起测试体系。
4. 构建UI和扩展：pnpm --filter @einfach-agent/browser-agent-ui build；pnpm --filter @einfach-agent/browser-extension build。验证pnpm exec vitest run browser-agent/ui/src/、pnpm exec tsc -b、git diff --check。写报告 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/310-report.md（绝不要写根reports/）。

读CLAUDE/.project-lines相关UI线，沿用one-file-one-thing普通文件≤300。大量前态未提交不要回滚；本次前态reports/310-before中每份有.before后缀。不得改core/manifest/其他工具、浏览器、pnpm install、真实key/模型、commit/push/远程issue、再委派。不改任务账本。构建保留上轮extension IIFE隔离。报告事实清晰且简短。
