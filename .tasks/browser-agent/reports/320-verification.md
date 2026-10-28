# 320 编排验收

状态：PASSED。R1独立复审330-review.md通过，无遗留质量项。

## 当前验证

- 执行 agent：page 16 files / 52 tests，page 包 build、根 tsc -b 全部通过。
- 编排亲验：extension build、embedded build 通过，日志320-extension-build.log / 320-embedded-build.log；state / boundaries / git diff --check 通过。
- Chrome 原生 MV3 完整调用 `handshake → page-call/readForm`，独立新 document 返回13个逻辑字段，详情320-browser-check.md。
- ZIP重新生成，12个extension文件及68个embedded文件逐字节对比dist、CRC及manifest校验通过；最终校验和见artifacts/checksums.json。
- 范围diff320-scope.diff包含已有任务增量及未追踪源码；320-delta.diff对照320-before精确显示本轮修改。无安装依赖、无commit/push/远程issue。

## 设计裁决

通用发现原生→ARIA/contenteditable→受约束DOM；站点特殊通过既有adapter。只读识别能力与写入supported、页面readOnly分开。读取不自动打开下拉，未暴露候选如实报告；缺稳定ID的候选仅显示label。约定已经写入工具包README。没有创建或修改全局memory skill。

## R1 最终产物与集成

- extension、embedded 均已基于R1最终源码重新构建，日志320-extension-build.log / 320-embedded-build.log均成功。
- 编排额外验证真实工具预览与扩展桥接兼容：`pnpm exec vitest run browser-agent/extension/tests/page-bridge.test.ts browser-agent/ui/tests/tool-preview.integration.test.ts`，2 files / 13 tests通过，日志320-bridge-integration.log。未重复page绿色测试。
- ZIP再次生成并逐文件/CRC校验：extension 12files / 1039569bytes / SHA256 `2c386bf66217fac738b0e1184845386de0fc5503d0320af88a335d64887c172a`；embedded 68files / 842844bytes / SHA256 `696b5d8551d7080ad3e197b6db7af3b6bd884827a30ff1bd22039cd01909a40c`。
- 实机13字段是R0证据；R1收尾时Chrome原生表面不可用（cgWindowNotFound），未声称最终安装实例再次重载或验证。最终源码、构建及离线回归已验，安装实例需要重载插件并刷新业务文档。
