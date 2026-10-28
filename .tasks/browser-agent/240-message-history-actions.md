---
id: '240'
title: 每条用户消息就地撤销并在原位置重做对应轮次
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '220'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/ui/**
  - packages/agent-core/src/runtime/commands/historyCommands.ts
  - packages/agent-core/src/runtime/commands/historyCommands*.test.ts
  - packages/agent-core/src/runtime/commands/sessionScopeCommands.ts
  - packages/agent-core/src/runtime/commands.ts
  - packages/agent-core/src/state/sessionHistory.ts
  - packages/agent-core/src/state/sessionTurnHistory*.ts
  - packages/agent-core/src/state/persistence/historyLogRoundTrip.test.ts
  - packages/agent-core/src/index.ts
---

用户明确纠正：redo/undo 应放在每条用户发送的记录下，原全局「会话操作」失去消息上下文。直接执行，不再次问偏好。沿用现有tasktree，编排只审查/浏览器/账本，执行者负责产品。

## 已核实代码与约束

- 当前 browser-agent/ui/src/chat/ChatView.tsx 全局details调用 undoTurn(sessionId)/redoTurn(sessionId)，只弹下一个label，放到任意旧消息下仍会撤最新轮，不能只挪按钮。
- 核心 runtime/commands/historyCommands.ts 已有 retractTurn(userItemId)，定位 user append entry，预检整段屏障，回滚该消息及后续分支；现只用activeSessionId，需向后兼容补 optional sessionId，嵌入必须显式传显示会话。apps/web/src/agentNew/ui/MessageList.tsx已有消息下撤回实例，可参考设计但不能复制其全局单例/active选择耦合。
- 普通 redoTurn 按label一次不能可靠恢复真实sendMessage整轮（第一条user append可能unlabelled）；不要在UI按次数循环猜测、不要用重新请求模型冒充redo。
- 现有 session.history.stackAtom/getState() 含完整 entries/cursor，items:append 的op.after是ConversationItem，可从既有日志派生可撤销目标及被撤消息，不要新建第二套历史/快照/持久化格式。UI仅useAgentAtomValue读命令暴露的只读派生atom，再调用commands，不能持有History/直接setter/writer。
- 先读 CLAUDE.md、.project-lines/SKILL.md及其01状态/15渲染线；旧服务端迁移是未实施方向，本用户已明确本功能纯Web，不扩大迁移。读 Apple HIG skill与undo-and-redo.md、buttons.md；用户明确消息下操作优先于原生菜单建议。普通源码/测试<=300，应用one-file-one-thing。

## 行为合同

1. H01 每条当前用户消息下放轻量撤销图标/短文案，标题说明「撤销此消息及后续对话」。需准确作用该userItemId及显示sessionId，不影响另一会话/实例。不再在底部放全局历史操作栏。不可撤的旧消息或屏障前消息给disabled及明确原因，不能看似可用却撤别轮。
2. H02 撤销后在原时间线位置保留淡化的用户消息占位，标「已撤销」，其下面提供就地重做入口。占位只用于UI投影，不把已撤消息重新写回active items/发送给模型。最好从同一本history日志纯派生，刷新/重新挂载时还能按已持久化日志重建，切session/client绝不串。撤销所有消息后重做入口仍可见。不要只保存最后一次操作的单个React临时变量而让较早撤销无入口。
3. H03 重做恢复所选轮的原有日志状态（含相应assistant/tool结果），不调用sendMessage或重跑工具。恢复较后被撤轮时，线性日志必须包含其前面被撤轮，文案明确「恢复至本轮」。只恢复至该轮结束，后续更晚被撤轮仍为占位。可在core增加小的目标式restore命令/纯派生read模型，全部复用同一日志，无新通用历史框架/无新包。目标必须以userItemId+session校验当前日志，截断的redo分支/过期目标须拒绝且不部分恢复。
4. H04 发送新消息会按原日志规则丢弃redo分支，原已撤占位应同步消失；不要保留还能点的旧重做。复用现有不可逆屏障、停止在飞run及stale guard，撤销不会回滚已经执行的网页外部动作，提示就近tooltip/辅助说明，不重新加整条常驻警告。保留错误/拒绝反馈；忙碌时动作含停止提示。不能绕过屏障或把会话状态直接截成数组冒充撤销。
5. H05 保持220版聊天大区域/固定输入框/右上角配置/草稿与client隔离，以及runtime详情折叠。动作贴在用户气泡下面，视觉轻、不新加大卡/重复双全局按钮；只有需要的状态给redo，不在每条活跃消息下永久堆disabled redo。图标inline SVG且32px点击区/aria-label/title，键盘可用，窄/宽都合适。

## 设计裁决权限与文件

只做完成上述用户结果必要的 additive core API，不改旧undoTurn/redoTurn契约。建议复用retractTurn并补session参数，加 restoreRetractedTurn(userItemId,sessionId?) 等目标式命令；只读派生可放sessionHistory.ts，共享纯定位/投影可放state/sessionTurnHistory.ts，具体内部形状由执行者判断并在报告简述。若声明范围不足先报告原因，不能自行改持久化格式或门禁白名单。core/historyCommands当前约204行，若变超300按职责抽内部实现，需先报新增路径。

就近测试必须用真实core日志/真实模拟sendMessage形成多轮，不仅用手工相同label假数据：三轮撤中间消息→保留第一轮；原位置redo→恢复原回复而模型fetch计数不增；更后轮目标redo的线性边界；新分支废弃redo；显式目标不同于activeSessionId；不可逆屏障不部分回退；UI user位置/占位/点该消息/全撤仍可redo/设置往返与多client。已有BrowserAgentView.test.tsx 287行，新增场景新文件避免超限；原undo旧期望应替换为消息目标语义，保留原其他命令断言。

可在ui/tests/fixture.testFixtures.tsx添加history场景：本地模拟fetch经过真实sendMessage预置3轮，并selectSession。编排用原生Chrome CUA验证中间轮撤销/就地redo、消息区/窄宽图证；执行者禁止操作浏览器、CDP/Playwright、钥匙串、真实APIKey。

根cwd运行相关historyCommands/persistence历史日志/屏障测试、browser-agent/ui+extension；新增导出时core build→UI及依赖必要build→extension build；根tsc、state、boundaries、docs；CLAUDE要求的pnpm build由编排或执行者覆盖一次并报告。禁止install/改lock/commit/push/远程issue/再次派发。已有所有未提交工作保留。
报告只写 /Volumes/work/ai/web-agent/.tasks/browser-agent/reports/240-report.md。若设计有两种合理方式，选择最小能满足精确轮次/持久化/隔离的方案直接实施。视觉可验收及dist完成提前通知编排；独立250复审后收口。

## R1 独立审查修正

250-review.md 指出原生 disabled 让键盘用户无法聚焦并获知消息撤销不可用原因。采用原位 aria-disabled + 阻止激活，焦点时显示紧凑关联说明（不常驻扩大对话区），补真实 Tab/Enter/Space 不触发命令测试。只修这一点，UI/extension 最终重新构建，已绿的 core 测试不重复跑。报告追加 R1 结果。
