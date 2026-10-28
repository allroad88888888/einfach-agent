# 050 R1 独立预审

结论：**NEEDS_CONTEXT**

本轮只读复核 `050-extension-embedding.md` 的 R1 裁决、`050-report.md` R1 记录、`050-scope-r1-preliminary.diff`、对应源码及已保存证据。按要求未重跑测试、未启动浏览器、未修改产品代码。050 的最终结论仍依赖 070 的公共 `dispose({ preserveRecovery: true })` 合同及接入后的运行中关闭/恢复实机证据，因此本预审不提前给出 PASSED。

## 原审查问题复核

### I1：真实运行时工具拒绝/API 失败

✅ **已补齐。** `browser-agent/extension/tests/runtime.integration.test.ts` 新增经 `createBrowserAgent` 和真实 core dispatcher 执行的三条失败链：

- readonly Agent 实际请求 allowlist 外的 `fill_fields`；断言页面值未改变，证明页面 host 未执行；
- denied-source Agent 实际请求未授权 `cities`；断言 source 没有被调用；
- broken-source Agent 调用已授权 source，adapter 抛出含 `fixture secret` 的内部错误；断言只调用一次、返回安全错误且不泄漏该字符串；
- 三条 run 均消费工具结果并到达 `done`，不是只检查 tools 数组或 capability 配置。

R1 报告记录受影响定向测试为 2 files / 7 tests passed。该结果与源码断言一致；本轮未重复执行。

### I2：真实 reload / cancel

✅ **reload 已补齐。** `browser-agent/extension/tests/browser-harness.js` 对固定 tab 执行真实 `chrome.tabs.reload`，随后用旧 target 调用失败，再显式 handshake 获得不同 documentId，并用新 target 成功 `readForm`。`050-evidence/mv3-report.json` 保存了旧目标 `CONTENT_SCRIPT_UNAVAILABLE/unknownResult:true`、新 documentId 和成功 read 结果。

✅ **cancel 已按 R1 裁决补齐。** Chrome harness 通过扩展消息通道以相同 requestId/target 发送 page call 与 `cancel-page-call`，证据记录 cancel `{ok:true}`。同步 read 已先完成，报告没有将其描述为“中途取消成功”。迟到异步结果隔离另由真实 Chrome embedded fixture 覆盖：adapter 已进入后 abort，再释放 continuation，`embedded-report.json` 记录 `entered:true`、`aborted:true`、`lateWrite:false`、DOM 仍为 `before`、结果为 `AbortError`。这符合 R1 明确允许将真实 IPC 通道与公开 adapter 的异步取消证据分开验证的裁决。

### M1：受控组件与失败 fixture

✅ **已补齐。** embedded 两个 iframe 均通过公开 `controlledAdapters` 注册受控字段；真实模型/tool dispatch 将其写为 `adapter-value`，保存报告中两个实例均有该值。独立异步 adapter fixture 同时验证进入后取消。接口失败由 I1 的未授权 source 与抛错 source 覆盖；既有扩展测试继续覆盖权限拒绝、受限页面和 unsupported 文件字段。

## 初始化错误面

✅ **静态实现满足要求。** `browser-agent/extension/src/sidepanel.tsx` 将 `createBrowserAgent` 与 `bridge.restore` 放在同一 `mount()` 错误边界内；失败时在既有 root 中渲染 `role="alert"`、可读标题/错误和 Retry 按钮。错误正文通过 `textContent` 写入，避免把异常文本作为 HTML；Retry 执行页面 reload。正常路径仍在恢复完成后挂载 UI。

当前 R1 报告没有单列初始化失败自动化证据，但这不是原验收标准中的浏览器矩阵硬项；实现足够直接，本预审不据此新增阻断问题。

## 仍待上下文

⚪ **NEEDS_CONTEXT：运行中关闭 side panel 后的可恢复状态。** 当前生产入口仍在 `pagehide` 调用无参数 `client.dispose()`；R1 报告已实测这会把进行中 run 写成 `stopped`，因此没有冒称完成。源码中的最终恢复 E2E 步骤已准备检查“可恢复上次运行”、绑定恢复和继续完成，但现有 `mv3-report.json` 尚无 `interruptedRecovery` 字段，不能作为通过证据。需等待 070 独立审查通过后，050 接入 `client.dispose({ preserveRecovery: true })`，再以更新后的真实 side panel 报告核实：

- 关闭时未完成 run 保持可恢复语义；
- 重开后相同 session 的恢复入口与页面绑定同时可见；
- 用户触发恢复后 run 安全继续并完成；
- 默认无参数 dispose 仍维持既有停止语义。

## 新问题

未发现新的 Critical、Important 或 Minor 问题。

除上述 070 依赖和最后实机恢复证据外，原 I1、I2、M1 以及初始化错误面在本次预审范围内均可关闭。
