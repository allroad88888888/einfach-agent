# 120 R2 独立复审

结论：**REJECTED**。R2 已修复 R1 报告中的四项 Important 与 Request clone 的 pending 状态，但为支持每 capture 独立正文上限而直接引入了 recorder 预缓冲限制回退。

## Critical

无。

## Important

1. `browser-agent/tools/network/src/window-observer.ts:30-48` — 当前共享 observer 在后续 recorder 或普通 host 加入时，对 `maxRequests` 和 `maxBodyChars` 使用 `Math.max`。这使一个 `maxRequests: 500` / `maxBodyChars: 65536` 的 active host 可以把已安装 recorder 的默认 100 条 / 32 KiB 页面预缓冲扩大到 500 条 / 64 KiB；第二个较宽松 recorder 也会扩大第一个较严格 recorder。它直接违反 R1 生命周期裁决“多个 recorder 采用更保守的限制，host 不能扩大 recorder 的容量、正文或年龄上限”，并突破 recorder 对内存预采集的公开边界。`window-host.test.ts:84-104` 只在 host 加入前发送两次请求，此时 recorder 已将缓存裁为一条，未验证二者共存后继续发生的请求，因此无法发现扩容。active capture 本身已有独立 records 且 `cloneForCapture` 可按 capture 限制输出；共享预缓冲仍应保持所有 recorder 中更保守的容量/正文限制，host 的实时监听能力不能通过扩大 recorder buffer 获得。

## Minor

无。R1 的 Request clone `requestBodyState` 问题已在 `browser-agent/tools/network/src/window-observer.ts:101-104`、`:190-204` 修复为读取期间 `pending`。

## R1 项验收

- 每 capture 正文上限：`browser-agent/tools/network/src/window-host.ts:55-75`、`:188-213` 已在复制 record 时按自身限制二次约束，关闭不同 host 输出相互放大的问题。
- 迟到更新：`browser-agent/tools/network/src/window-observer.ts:30-31`、`:209-249` 和 `browser-agent/tools/network/src/request-input.ts:21-44` 已清理被替换记录，并在异步读取后复核 record 存活。
- 滚动 timer：`browser-agent/tools/network/src/window-observer.ts:39-44`、`:291-294` 已在年龄缩短时立即 prune 并重建 interval。
- 直接 host 校验：`browser-agent/tools/network/src/window-host.ts:244-271` 已对 `methods`/`method` 做非 `undefined` 后的精确类型检查。

## 验证记录

- 按 R2 要求未重复运行报告中已通过的 13 files / 33 tests、TypeScript、build 或 docs。
- 本轮结论来自 `reports/120-r2-scope.diff` 与冻结源码逐行审查；未执行临时复现，因此没有新增日志。
- 普通 source/tests 均未超过 300 行；当前最大为 `window-observer.ts` 294 行、`window-host.ts` 285 行。
