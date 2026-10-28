# 130 R1 独立复审

结论：**PASSED with Minor**。R1 已修复原审查的 3 个 Important、1 个 Minor，以及补充指出的 `routeNetwork` 异步拒绝不回包问题。未发现 Critical 或 Important。

## 原发现复核

- ✅ 注册队列不再被单次失败永久污染：当前 attempt 会向 handshake 返回失败，内部 `registration` 通过 catch 恢复，后续调用可重试（`browser-agent/extension/src/script-registration.ts:5-18`）。后台生命周期入口统一使用吸收错误的 `syncScriptsBestEffort`（`browser-agent/extension/src/service-worker.ts:4-9,128`），避免未处理拒绝。
- ✅ `route()` 现在 `await routeNetwork()`（`browser-agent/extension/src/service-worker.ts:34`），probe 或 MAIN `executeScript` 的异步拒绝会进入既有 catch 并固定回复，不再留下悬挂的 message channel。
- ✅ 页面不可信结果已有双层总传输上限，并按结果类型约束数组条数、字符串、header、数值和枚举（`browser-agent/extension/src/service-worker.ts:61-73,96-127`）。原先可用超大数组/正文穿过浅层校验的问题已关闭。
- ✅ 权限 pattern matcher 已覆盖 `*` scheme、`*` host 和 `*.example.com`（`browser-agent/extension/src/script-registration.ts:38-49`）。
- ✅ 新增测试真实加载 `network-main.ts` 与 120 recorder/host，覆盖未开对话的早期 fetch、默认 buffered capture、BFCache 释放/重装、刷新后旧 capture 隔离及撤权 dispose；这部分不再仅由路由 mock 外推。
- ✅ 动态注册失败后恢复、并发 handshake、通配 host 撤权、执行脚本拒绝回包及超限/非法结果拒绝均有定向回归证据。

## Minor

1. 结果校验会拒绝合法的空 header value。

   `validHeaders()` 对每个 value 调用要求长度大于 0 的 `bounded()`（`browser-agent/extension/src/service-worker.ts:115,122-126`）。HTTP header field-value 可以为空，120 的 `sanitizeHeaders()` 也没有排除空值，因此合法捕获可能被误报为 `INVALID_NETWORK_RESULT`。建议 header key 继续要求非空并限制长度，value 改为允许空字符串但保留 8192 字符上限，并补一个空 header value 用例。该边缘兼容问题不破坏安全容量边界，也不阻塞本任务通过。

## 验收结论

- ✅ 六项网络工具、session/target 隔离、未绑定 fail closed、旧 capture、取消与 dispose 路径成立。
- ✅ ISOLATED 逻辑 binding 校验后，以同次 probe 的原生 `documentId` 固定 MAIN 调用；导航竞态边界成立。
- ✅ 动态注册两个 top-frame `document_start` world，仅使用已授权 web origins；首次 handshake 注入当前 Document；无新增 manifest 必需权限。
- ✅ 提前预缓冲与刷新/BFCache 生命周期已有真实模块接线证据；根 CUA 的纯 Web 本地 HTTP 初始化请求另见 `reports/140-browser-check.md`，报告未将其冒充真实 MV3 实测。
- ✅ MAIN 结果容量与结构校验、异步错误回包、权限注册恢复均满足任务要求。
- ✅ 报告记录 tsc、build、自包含 bundle 和完整 extension 测试通过；按复审要求未重复执行这些测试。

本次只读复审，未修改产品源码。
