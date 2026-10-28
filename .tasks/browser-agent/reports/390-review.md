# 390 独立覆盖审计 / 终审

结论：**APPROVED**

审查范围：`390-dom-audit.md`、`index.md`，370/380 任务、报告、scope/delta、R1 独立复审，以及 `390-verification.md`、`390-browser-check.md` 和最终日志。按任务约束未重跑测试，未操作浏览器/CDP/真实模型，未修改产品或任务账本。

## Critical

无。

## Important

无。

## Minor

无。

## D01–D06 覆盖结论

- **D01 PASS。** 新的 `@einfach-agent/tools-browser-dom` 是纯 Web 包，公开六工具、严格 schema、registry 注册和结果 validator。370 的普通无 ARIA `div`/`span`、异步 body 弹层、搜索过滤、选择“安全漏洞”及最终显示回读证据，与 390 CUA 在本地 fixture 中实际看到的五步 ToolRegistry→DOM host 链一致。CUA 证据证明的是本地可见 fixture 的真实链路，没有被写成客户业务页 MV3 验收。
- **D02 PASS。** 370 R1 已独立核验精确 Element/ref 与 PageRef 身份、替换/移除/导航、各可重入事件阶段取消、隐藏与敏感字段、祖先 disabled/`aria-disabled`、fieldset 首 legend 例外、ARIA combobox、原生 select、wait 截止与清理，以及 DOM/page 共用 document 写队列。动作结果只声明 `dispatched:true`，指南和验收均要求业务状态回读。
- **D03 PASS（保留真实限制）。** 380 R1 的实际组合测试覆盖同一 transport 上 bridge→service worker→content script→DOM host 的六方法、绑定 document、取消、旧导航、错页、畸形 nested node，以及四项 DOM 写动作失联的 `unknownResult`/不重放。最终 extension bundle 成功。真实已安装 MV3 扩展在客户业务站点调用新 DOM 工具未实测，报告已明确保留，不能将组合测试或 fixture CUA替代该项现场验证。
- **D04 PASS。** extension、embedded 与 UI fixture 均注册 DOM 工具；双 iframe/namespace/session 的 mock-core 模型运行会消费最终 `read_dom` tool message，并分别校验目标 PageRef 与“安全漏洞”回读后才结束。CUA 另证配置目录显示六项 DOM 工具和总计 25 项能力。既有 Agent 的 `toolNames` 与既有 session 的能力快照没有被默认扩展；使用新能力需勾选并新建会话。
- **D05 PASS。** workspace 依赖、根 alias/paths、边界扫描和公开包面均已接入；生产 extension 的 `fixture-cities` 在 src/dist 为零命中，演示来源只留在 fixture/embedded。实际 tgz 的 ESM 入口、六工具、普通 DOM 选择回读与 NodeNext declarations 均通过消费验证，且未引入 UI/Chrome globals。extension/embedded ZIP 的逐文件、CRC、manifest 与 checksums 校验为绿。
- **D06 PASS。** 最终相关范围为 72 files / 254 tests 全过，`tsc -b`、extension/embedded builds、state/boundaries/docs/diff gates、packed ESM/d.ts 与 ZIP 校验均有日志；370 和 380 R1 均由独立 reviewer APPROVED。scope 与 delta 分别保留完整任务面和 R1 精确增量，差异本身符合两轮修复记录，未见未纳入审查的产品漂移。

## 真实适用边界

当前证据支持 top document，或由宿主显式提供的同源 iframe document；不覆盖跨源 iframe、closed shadow root、依赖 `isTrusted` 的交互或可信键盘默认动作。读取不会主动展开控件或推断未暴露的业务 value。真实客户站点 MV3 新工具选择仍需重载扩展、刷新目标文档后另行现场验证；本终审不将其列为已完成实测。
