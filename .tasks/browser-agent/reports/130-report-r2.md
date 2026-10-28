# 130 R2 生命周期修复报告

## 修复

- MAIN recorder 生命周期区分页面暂挂与永久销毁。`pagehide` 只释放当前 recorder、host、capture 和 gateway；`pageshow.persisted` 可以从仍有效的生命周期恢复。
- gateway 的公开 `dispose()` 现在执行永久销毁：释放当前资源、移除 `pagehide` / `pageshow` 监听并删除 lifecycle marker。权限撤销后触发 BFCache `pageshow` 不会重新安装 recorder。
- 后续明确授权并重新注入 `network-main.js` 会创建新的生命周期和 recorder，保持重新授权可恢复。
- 网络结果 header 验证允许合法空字符串 value，同时继续拒绝空 header name，并保留 header 数量、名称和值长度上限。

## 回归覆盖

- 真实 `network-main.ts` + 120 recorder/host 测试新增：永久 dispose 后 `pageshow.persisted` 不重装；重新注入后 gateway 正常恢复。
- service worker 返回验证新增：空 header value 通过，空 header name 返回 `INVALID_NETWORK_RESULT`。

## 验证

- `pnpm --filter @einfach-agent/browser-extension exec vitest run browser-agent/extension/tests`：6 files / 22 tests passed。
- `pnpm --filter @einfach-agent/browser-extension exec tsc --noEmit -p tsconfig.json`：通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过；`network-main.js` 无外部 import。
- `node scripts/check-docs.js`：通过；产品源码 `git diff --check` 通过。
- 未执行 install，未启动浏览器或 CDP，未修改 manifest 权限。
