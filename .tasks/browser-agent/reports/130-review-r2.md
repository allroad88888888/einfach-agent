# 130 R2 独立复审

结论：**PASSED**。R2 的三个窄修均成立，未发现由本轮修改直接引入的 Critical、Important 或 Minor 问题。

## 复核

- ✅ 权限撤销后的永久销毁不会被 BFCache `pageshow.persisted` 复活。公开 gateway 的 `dispose()` 转交 lifecycle 永久销毁；永久销毁释放 recorder/host/capture、删除 gateway、移除 `pagehide` / `pageshow` listener，并删除 lifecycle marker（`browser-agent/extension/src/network-main.ts:46,49-58`）。因此撤权清理后既无现存 gateway，也无残留 pageshow 回调可重新安装。
- ✅ 普通页面暂挂仍可恢复。`pagehide` 只调用 `releaseCurrent`，保留 lifecycle；`pageshow.persisted` 调 `installGateway`，创建新的 recorder/host/capture 集合（`browser-agent/extension/src/network-main.ts:18-27,49-52`），旧 capture 不会串入恢复后的实例。
- ✅ 重新授权并重新注入可用。永久销毁已删除 lifecycle marker；后续执行 entry 会进入新 lifecycle 分支并立即 `installGateway()`（`browser-agent/extension/src/network-main.ts:16-17,60-63`）。若只是暂挂后重新注入，则现有 lifecycle 的 `resume()` 同样恢复 gateway。
- ✅ 合法空 header value 的兼容问题已窄修。`validHeaders()` 继续要求非空且有界的 header name、字符串类型和 8192 字符 value 上限，但不再要求 value 长度大于零（`browser-agent/extension/src/service-worker.ts:122-126`）。对应回归同时证明空 value 接受、空 name 拒绝。
- ✅ 生命周期真实接线测试覆盖永久 dispose 后 pageshow 不重装，以及重新执行 `network-main` 后恢复；测试仍使用真实 120 recorder/host，而非只 mock gateway 返回。

## 验收结论

- ✅ R1 已通过的 native documentId 固定、导航/取消竞态、错误回包、注册恢复、容量验证和提前采集闭环保持不变。
- ✅ R2 修复没有扩大权限、改变公开网络合同或引入持久存储。
- ✅ 报告记录 extension 22 项测试、tsc、build、自包含 bundle、docs 与 diff check 通过；按复审要求未重复执行测试。
- ⚠️ 验证边界仍与报告一致：纯 Web 与模块接线已有证据，未声称真实 MV3 客户站点已实测。

本次只读复审，未修改产品源码。
