# 130 独立审查

结论：**REJECTED**。原生 `documentId` 固定、独立 MAIN bundle、六方法桥接、立即取消与 sidepanel capture 清理的主路径成立；但动态脚本注册的失败恢复、页面返回值容量边界，以及最新“提前采集”验收证据仍未达到任务要求。

## 发现

### Important

1. 动态注册队列一旦失败就永久中毒，后续启动、授权添加、handshake 都无法恢复。

   `syncRegisteredScripts()` 只用 `registration = registration.then(...)` 串行化（`browser-agent/extension/src/script-registration.ts:5-17`）。只要 `getAll`、`unregisterContentScripts` 或 `registerContentScripts` 任一调用拒绝，`registration` 就保持 rejected；下一次调用接在 rejected promise 的成功分支上，注册逻辑不会再运行。service worker 启动和事件监听又都以 `void syncRegisteredScripts()` 调用（`browser-agent/extension/src/service-worker.ts:5-9`），因此一次瞬时 Chrome API 失败既可能产生未处理拒绝，也会让此 worker 生命周期内之后的 `onAdded` 和首次 handshake 持续失败。任务明确要求注册过程串行、幂等，并覆盖权限更新/恢复；当前实现只覆盖成功并发，不覆盖失败后恢复。应让队列在每轮前/后恢复到可继续状态，并补“首轮 register 失败、下一轮成功”的定向测试。

2. MAIN world 返回值只有浅层形状检查，没有任务要求的容量界限，页面可让扩展接收任意大的字符串和数组。

   `validNetworkResult` / `validCapture` / `validSummary` 仅检查少数字段类型（`browser-agent/extension/src/service-worker.ts:93-112`）。例如 `listRequests.requests` 数量无限，summary URL/method、response body/header、request body 都没有长度或总大小限制；数值也未要求 finite/non-negative。任务明确规定“全部结果视为页面不可信输入，固定结构验证+容量界限”。由于 gateway 位于页面 MAIN realm，网页可以替换或影响返回值；当前验证允许巨大 structured-clone payload 进入 sidepanel，违背该边界。应在 service worker 对每种结果做完整、有限的验证（或在 clone 前设计有界传输），并补超长 body/header、超量 list、非法数值拒绝测试。

3. 最新用户修正中的关键提前采集闭环没有测试证据，现有测试也没有执行 `network-main.ts`。

   `script-registration.test.ts` 只断言两个注册描述符；`service-worker.test.ts` 的 startCapture 结果由 `executeScript` mock 直接返回；`network-bridge.test.ts` 同样 mock `runtime.sendMessage`。因此“未开对话已有请求 → 后续 startCapture(includeBuffered 默认 true) 能读取早期请求”、刷新后新 Document 不沿用旧 capture、权限撤销实际 dispose recorder、pagehide/bfcache 行为均未验证。任务在“新增测试”中明确列出这些场景，报告却将四个 mock 测试概括为交付证据。至少应以可控 Window/fetch/XHR 环境执行 MAIN entry 与 120 recorder/host 的真实接线测试；120 尚未交付的行为不能外推为 130 已验收。

### Minor

1. 权限撤销清理的 URL pattern 匹配只可靠处理精确 origin，不能正确匹配合法的通配 host pattern。

   `matches()` 仅替换 `*://` 和末尾 `/*` 后比较 `URL.origin`（`browser-agent/extension/src/script-registration.ts:37-39`）；例如 `https://*.example.com/*` 不会匹配 `https://app.example.com/`。当前 UI 请求的是精确 origin，因此主路径暂不受影响，但 `permissions.getAll()` / `onRemoved` 合同接受 manifest match patterns，清理逻辑不应默默漏掉合法授权模式。建议使用明确的 Chrome match-pattern matcher并覆盖通配 scheme/host 测试。

## 验收逐条结论

- ✅ 六项 `NetworkToolsHost` 方法、双 session 目标、不绑定 fail closed、取消立即拒绝/丢弃迟到结果、dispose stop：实现与现有 mock 测试可证。
- ✅ 网络调用先读 ISOLATED 逻辑 binding，再使用同次 `InjectionResult.documentId` 的 `documentIds` 调 MAIN；导航 check/use 竞态主路径已封闭。
- ✅ service worker 检查扩展 sender；未知 method 在 protocol 边界拒绝；网络请求未携带模型凭据。
- ✅ 动态注册两个 top-frame `document_start` world，manifest 未新增必需权限；独立 bundle entry 已接入。
- ❌ 注册失败后恢复与权限更新/撤销完整测试不通过，见 Important 1、3。
- ❌ 页面不可信结果的结构/大小边界不通过，见 Important 2。
- ❌ 提前预缓冲、刷新隔离及真实 120 生命周期接线未被测试证明，见 Important 3。
- ⚠️ 报告所述 extension tsc 被 120 阻塞不单独判为 130 缺陷；本审查也未外推任何 120 尚未证明的行为。

本次按要求未重复执行报告中已通过的测试，也未修改产品源码。
