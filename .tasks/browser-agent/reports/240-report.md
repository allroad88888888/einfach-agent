# 240 执行报告

状态：DONE

## 交付结果

- 核心新增同一本会话历史日志的只读轮次投影：按 `items:append` 中真实用户条目定位 active/retracted 状态，不依赖轮标签。历史 cap 外的活跃旧消息仍显示，但撤销按钮禁用并解释原因；不可逆屏障同样在每条消息就地禁用。
- `retractTurn(userItemId, sessionId?)` 支持显式会话，先整段预检屏障，运行中先停止，再从目标用户 append 起撤回全部后续日志。成功后自动走 recovery/history 同代持久化栅栏。
- 新增 `restoreRetractedTurn(userItemId, sessionId?)`：从当前 cursor 线性回放到所选轮结束（下一条用户 append 之前），恢复原 assistant/tool/run 状态，不发模型请求、不重跑工具；目标不在 redo 尾或新分支已截断时整段拒绝。多 entry 回放失败会退回初始 cursor。
- Browser Agent UI 移除全局「会话操作」栏。每条活跃用户消息下显示轻量 32px 撤销按钮；撤回后原位置显示淡化的「已撤销」占位与「恢复至本轮」。按钮含 inline SVG、键盘语义、aria-label/title；tooltip 说明运行中会先停止，以及对话撤销不会回滚网页/业务外部动作。
- 新增 `?scenario=history` fixture，以真实 `sendMessage` 预置三轮，供编排在原生 Chrome 验收中间轮撤回、就地恢复及窄宽布局。

## 设计裁决

- 轮边界取“用户 append 到下一条用户 append”，而不是 `HistoryEntry.label`。真实发送验证了第二条 user append 沿用上一轮 label；按 label 恢复会错轮。
- 占位完全由 `history.entries + cursor + active items` 纯派生，不新增 atom 槽、快照字段或持久化格式。新消息提交时 createHistory 原生截断 redo 尾，旧占位同步消失。
- 定向命令成功后复用 `core.persistence.persistRecovery()`，由现有 bridge 在 recovery snapshot 保存成功后刷同 generation 的 history cursor；不安装 atom subscription。
- 文件职责：`sessionTurnHistory.ts` 只负责日志中的用户轮定位/投影；命令继续留在 `historyCommands.ts`（221 行）；消息动作渲染留在 59 行的 `ConversationTimeline.tsx`。新增/大改文件均低于 300 行。

## 验证

- 定向 core + UI：10 files / 41 tests 通过。覆盖真实三轮 `sendMessage`、错位 label、中间撤回、较后目标线性恢复、原回复恢复且 fetch 不增、新分支废弃 redo、显式 session 隔离、busy 撤回/恢复为 stopped、屏障拒绝、UI 原位按钮/占位/禁用原因。
- 持久化：撤回命令自动落盘 → 新 core hydrate 重建占位 → 恢复命令自动落盘 → 再次 hydrate 重建 active 轮次，测试没有手动调用 `persistRecovery`。
- `pnpm exec tsc -p tsconfig.app.json --noEmit` 通过。
- `pnpm check:state`、`pnpm check:boundaries` 通过。
- `pnpm --filter @einfach-agent/core build`、Browser Agent runtime/UI、extension build 通过；UI 与 extension 在最终源码上再次顺序构建通过。
- `pnpm build` 通过（tsc-b、Vite、server build）；仅输出仓库既有动态/静态 import 与 chunk size 警告。
- `git diff --check` 通过；新增/大改源码行数：75 / 221 / 103 / 79 / 59 / 38。

## 浏览器交接

已提前通知编排使用 `?scenario=history` 做原生 Chrome CUA。执行者未操作浏览器、CDP、Playwright、钥匙串或真实 API Key。

## R1：禁用原因键盘可达性

- 按 250 独立审查修正原生 `disabled`：阻断态按钮保留在 Tab 顺序，使用 `aria-disabled="true"`，并在统一激活 guard 中拒绝鼠标、Enter 与 Space，不会调用撤回命令。
- 禁用原因以 `aria-describedby` 关联到原位紧凑说明；说明默认不占消息区，按钮获得焦点时通过 `:focus-within` 展开。保留原 aria-label/title 与 32px 轻量点击区。
- UI 定向 3 files / 16 tests 通过；新增真实 `userEvent.tab()`、Enter、Space 覆盖并断言命令零调用。
- Browser Agent UI 与 extension dist 已在 R1 源码上顺序重建通过。按 R1 要求未重复运行已绿 core 测试。
- CUA 窄屏真实撤销通过后收紧占位对比：移除父 article 的整体 `opacity`，改由 muted 正文、虚线与灰底表达已撤状态；可操作的「恢复至本轮」不再随父级透明度变浅。布局不变。
