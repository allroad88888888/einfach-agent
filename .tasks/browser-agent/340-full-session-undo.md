---
id: '340'
title: 会话任意历史消息保持可撤销并跨恢复保留
kind: leaf
parent: browser-agent
depends_on: []
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - packages/agent-core/src/state/
  - packages/agent-core/src/runtime/
  - packages/persistence-idb/src/
  - browser-agent/ui/src/chat/
  - browser-agent/agent/src/
  - packages/agent-core/README.md
  - packages/persistence-idb/README.md
  - browser-agent/ui/README.md
  - browser-agent/agent/README.md
  - CLAUDE.md
  - .project-lines/lines/01-主线-会话状态与恢复.md
---

## 用户要求与优先约束

用户：『此消息已超过可撤销的历史，这个不应该存在，我的整个设计是任一时间任一点都能undo。』直接修复，不只是隐藏UI、不另起存储系统或任意调大到1000/10000。会话状态的历史应全保留，不因事务数/消息年龄/压缩过期，任意仍显示的用户消息可精确回退到其前并删除后续分支，撤销后原话回填聚焦，仍不显示redo（最新310要求）。已在外部执行的工具副作用不伪装回滚。历史损坏或旧版早已淘汰的日志不能伪造完整state，应查可恢复证据、清楚报告真实边界；不把正常限期当产品规则。

沿用task-tree，你改产品及本任务报告，root只编排。不碰其他无关修改、不commit/push/install依赖/远程issue/浏览器/真实模型/钥匙串。先读CLAUDE.md、.project-lines/SKILL.md中01与12相关线、one-file-one-thing。新/大改普通文件≤300行；既有超限文件仅必要小改，并报告。新文件先列职责。

## 已核实入口与根因

1. `state/sessionHistory.ts:createSessionHistory`无options调用`createHistory(store)`。已安装`@einfach/core`0.4.x的`esm/utils/createHistory.mjs`默认cap100，commit与hydrate均裁掉旧entries；一轮可十几事务。公开CreateHistoryOptions.cap只接受positive safe integer，Infinity/0都降回100。优先复用这个公开API为会话禁用实际条数淘汰，可用Number.MAX_SAFE_INTEGER并解释其覆盖JS所有可实现数组长度、不是产品历史窗口；不可修改node_modules/复制一套history引擎。若发现更合适现成机制先说明。
2. `state/sessionTurnHistory.ts`只定位items:append，丢了entry即history_unavailable；`runtime/commands/historyCommands.ts`retractTurn只用该entry定位，另有irreversible barrier。用户是在browser UI看到ConversationTimeline.tsx的『此消息已超出可撤销历史。』。不是UI钩子store错配。
3. browser-agent/agent/src/client.ts配置IDB sessions/recovery/historyLog，**没有配置agentRollout JSONL**。不能声称现有浏览器JSONL能补全过去已淘汰的逆操作。
4. persistenceBridge.persistRecovery当前在writer异步save成功之后才`flushPersistedHistoryLog`读取live history，与writer同步capture的state可能不同时；flush日志fire-and-forget，flushRecovery/dispose不等日志，连续generation/删除存在错配窗口。hydrate.ts仅配对generation一致，否则丢账。必须一起修正实际可复现的配对/flush失账问题，不能只加大cap就声称刷新永久可靠。复用现有writer/driver；如果需要可兼容可选配对driver接口或快照扩展，先短报设计给root，范围允许上述core/IDB，不新增包，不破坏未支持的driver契约。不能用错配日志回滚、也不能把错误吞为成功。
5. runLifecycleCommands.stopRun默认disposeUserContent true，实际释放provider上传才markUndoBarrier。userContentDisposal.ts的可达性目前只看live items/queued，不看日志。请评估用户最新“任一点”与新造barrier的冲突：应保留仍被历史引用的内容，避免普通stop让早期对话永不可撤；不要直接绕过已经存在的真实不可逆屏障、还原坏引用。复用可达性/会话删除生命周期，不要新增资源框架。将判断/方案先短报root；root同时审查这一链。
6. 当前工作树有多轮已验收改动：310删除redo、320通用form读取、270network提前捕获、240精确undo命令。不得回滚。前态reports/340-before及340-prechange.diff已保存。

## 验收覆盖

| ID | 必须交付 | 证据 |
|---|---|---|
| U10 | 没有事务数/年龄导致的历史淘汰；长对话第一/中间/最新消息均能精确撤销 | 至少>1000条真实writer事务，原始entry保留；撤回早期且其后plan/run/checkpoint/graph等状态一致，不能仅slice items |
| U11 | 长历史在持久化/恢复后仍能撤销；快照/日志捕获同一时点，flush等待完成 | 受控延迟save、连续写入/undo、多generation、dispose+重建；IDB或真实内存driver闭环，失败/删除不复活错配日志 |
| U12 | 压缩不削掉可撤销记录；运行中撤销阻断迟到回写；跨session隔离 | 复用真实core回归，含contextCheckpoint、早期用户消息、非active显式session |
| U13 | 每条用户消息的undo及回填继续工作，正常历史不再出现超出期限提示；旧版缺账诊断诚实 | browser真实core集成，历史>cap、恢复、点击早期消息，回填文字/焦点；无redo/占位重新引入 |
| U14 | 普通stop不能因可撤销历史资源而新造永久屏障；删除会话仍释放所有最终不可达资源 | 按上文先核实并落实可达性测试；旧真实barrier不绕过 |

最小必要文档记录无应用级淘汰政策与旧历史不可恢复边界；更新本次碰到的历史cap/双记录配对注释，不顺手重构全仓。先短报实现方案/新增文件，再修改。完成相关测试、根tsc、必要包build与diff检查，报告精确命令/计数/遗留至绝对路径 `.tasks/browser-agent/reports/340-report.md`。root负责最终构建/治理/浏览器可用时模拟QA和独立审查。不要重跑全仓测试反复消耗，先针对变更闭环。

## 实现裁决（2026-09-20）

340短报与root讨论后选择：RecoverySnapshotV1兼容可选history payload（entries/cursor/barrierTxId），与state同刻捕获、同记录原子saveLatest；外层generation绑定二者，不再依赖“先存快照后await外置日志”这种崩溃窗口。hydrate优先嵌入字段，缺字段才读legacy同generation日志。可停止新外置日志写入，保留旧driver接口/读取迁移/删除清理。codec与序列化失败必须受控，无凭空补账。生产web/cli/browser均已显式配置historyFor，无需新建自动装配层。旧IDB日志读取应保留合法barrierTxId。新分支discard redo尾的上传最终可达性由340核实最小方案，不能让保留历史资源永久丢失清理入口。

## R1 独立审查收尾

350唯一Important见reports/350-review-r0.md：isPersistedHistoryPayload对barrierTxId需非空并在entries中命中，不能接受损坏引用让undoCrossesBarrier默默当无屏障。采纳新嵌入与legacy共同校验闭合，补两路径fail-closed回归、定向测试/tsc。历史cap旧格式若已丢barrier定位证据，不能假定一个不认识的barrier是可安全跨越；记为旧日志无法验证，保留状态而不伪造安全账本。不要改真实已有barrier政策。

本轮文件限historyLogDriver.ts、就近recoveryDriver/historyLogRoundTrip测试及340报告，避免与360（multiClient/defaultPlugins诊断）交叉。不要完整重跑261文件，360负责该命令最终闭环。修复后发最终冻结消息，root派350复审。

最终收口：340 R1由350独立PASS，360独立PASS；261files/2078tests完整回归通过，无unhandled errors。根build、core/IDB/browser runtime/UI/extension/embedded构建及治理门禁通过。产物与真实浏览器边界见reports/340-verification.md。无commit/push/远程issue。
