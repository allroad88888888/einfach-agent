# 250 独立审查

状态：PASSED（R1）

## R1 结论

首轮唯一阻断已修复。`browser-agent/ui/src/chat/ConversationTimeline.tsx:45-50` 不再使用脱离 Tab 顺序的原生 `disabled`：阻断态按钮保留焦点能力，以 `aria-disabled="true"` 表达状态，使用 `aria-describedby` 关联原位原因，并由统一 `activate` guard 阻止点击、Enter 与 Space 调用撤回命令。`messageHistoryActions.test.tsx:30-42` 覆盖真实 Tab 聚焦、Enter/Space 和回调零调用，解决了 H05 的禁用说明与键盘可达性问题。

占位视觉也已收口：`conversation.css:19-27` 只弱化已撤消息的标题与正文，不再对整个 article 应用 opacity，因此可操作的“恢复至本轮”按钮保持正常对比；原因在 `focus-within` 时展开，窄宽下可换行且不扩大消息区常态噪声。这符合 Apple HIG `accessibility.md › Mobility` 的键盘单独导航原则、`keyboards.md › Best practices` 的 Full Keyboard Access 原则，以及 `buttons.md › Best practices` 对明确标签和可用命中区的要求。用户指定消息下操作优先，因此不要求改为原生菜单或全局工具栏。

## H01–H05

- **H01：通过。** 每条 active 用户消息把自身 `userItem.id` 传给 `retractTurn`，不是挪动旧全局撤销；历史淘汰和不可逆屏障都有目标消息自己的原因。
- **H02：通过。** 被撤轮由同一本 history 的 entries/cursor 投影，原内容以淡化占位保留；全撤后仍存在恢复入口。占位没有写入 active `itemsAtom` 或模型上下文。
- **H03：通过。** `restoreRetractedTurn` 只对既有日志执行 `redo()` 到所选轮的精确末端，不调用模型或工具；较后目标线性恢复之前轮。真实 `sendMessage` 回归断言原 assistant 回复恢复且 fetch 调用数不增加。
- **H04：通过。** retract/restore 接受并解析显式 `sessionId`；撤回先整段预检屏障，拒绝时不会 partial rollback；新分支截断旧 redo 尾，旧目标随后明确拒绝。运行中撤回先 stop，迟到写仍由既有 runId 防护；持久化 round-trip 覆盖重挂后投影与恢复。
- **H05：通过。** 动作位于对应用户消息下；360px 原生 Chrome 已显示三轮各自按钮，实点第二轮后第一轮完整保留、第二和第三轮在原位置显示占位与恢复入口。R1 修复了禁用原因的 Tab 可达性和占位恢复按钮对比；32px 控件满足当前桌面 Chrome 侧栏的命中区要求。

## 合同与范围

- 保留既有 `undoTurn`、`redoTurn`、entry API，新命令为增量接口。
- history 是轮次投影唯一真相，没有新增历史存储、快照字段或持久化格式；多实例仍由 session store 隔离。
- UI 通过公开 client/core 实例操作显式会话，没有引入默认实例路径；消息区域、底部输入框、配置页和 client 隔离边界未改变。
- R1 定向 UI 3 files / 16 tests、UI 与 extension 顺序构建由执行报告记录为通过。本复审遵照任务要求未重复运行已绿测试、未操作浏览器、未修改产品或账本。

## 浏览器覆盖限制

本轮原生 CUA 覆盖了 360px 三轮布局、每条消息的独立撤销入口，以及中间轮撤回后的精确保留和原位占位。用户随后并行使用 Chrome，编排为避免争抢焦点或打断真实会话，没有继续执行原生 redo、最终 R1 CSS 对比截图和本轮宽屏交互，也没有重载正在使用的扩展。

这些未执行项不冒称已有浏览器证据：精确 redo、较后轮/全撤恢复、新分支切断、刷新 hydrate、运行中 stop 和不新增模型请求由真实 core/sendMessage 回归覆盖；键盘激活、回调目标与禁用 guard 由 UI 回归覆盖；宽屏容器沿用 220 已验收布局，新增控制的换行规则经源码审查。依据任务追加的 R1 覆盖裁决，这一限制不构成当前阻断。用户使用已安装扩展前仍需重新加载新构建。
