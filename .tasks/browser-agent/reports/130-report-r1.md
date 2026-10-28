# 130 R1 修复报告

## 修复

- 动态脚本注册队列将单次 attempt 与可继续的内部队列分离。`getAll`、unregister 或 register 瞬时失败会返回给当前 handshake，但不会污染后续启动、权限事件或 handshake；后台生命周期调用统一吸收本轮错误，避免未处理拒绝。并发重复同步按授权 origins 签名幂等跳过。
- `route()` 改为 `await routeNetwork()`，使 `executeScript` 的异步拒绝进入既有 catch 并固定回复 `CONTENT_SCRIPT_UNAVAILABLE`，不再留下无回复的 message channel。
- MAIN 固定调用函数在 structured clone 前对 JSON 结果施加 200,000 字符总传输上限。service worker 在接收后再次限制总量，并完整约束 list 最多 100 条、URL、method、ID、body、reason、header 数量/键值长度以及 finite/non-negative 数值；超长或非法页面输入返回 `INVALID_NETWORK_RESULT`。
- 权限撤销 matcher 支持 `*` scheme、`*` host 和 `*.example.com` Chrome match pattern，仍只处理 web origin 注册。
- 新增真实模块接线测试：直接执行 `network-main.ts` 和 120 recorder/host，证明未开对话的早期 fetch 被默认 `includeBuffered` capture 读取；所有 pagehide 释放 recorder/host/capture，BFCache `pageshow.persisted` 重装 recorder 且旧 capture 不可复用；普通刷新同样建立新 gateway；权限撤销实际 dispose recorder 并删除 gateway marker。
- 新增注册首轮失败后成功、并发 handshake 幂等、通配 host 撤权、executeScript reject 回包、超量 list/body/header 与非法结果拒绝测试。

## 验证

- `pnpm --filter @einfach-agent/browser-extension exec vitest run browser-agent/extension/tests`：6 files / 21 tests passed。
- `pnpm --filter @einfach-agent/browser-extension exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过；`network-main.js` 为独立自包含 bundle，无外部 import。
- `node scripts/check-docs.js`：通过。
- 未启动浏览器或 CDP，未执行 install，未改 manifest 必需权限。真实 MV3 场景仍由 140 与编排 CUA 验证。
