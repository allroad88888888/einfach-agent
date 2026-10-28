# 120 网络工具 R1 修复报告

## 审查项修复

- 敏感键先拆 camelCase，再统一 snake/kebab/空格分隔词，覆盖 `client_secret`、`refreshToken`、`auth-token`、`session_id`、`csrfToken` 与 `API key`；URL、嵌套 JSON、urlencoded 均有回归。非法或超限 JSON 只返回 omitted，不返回原文前缀。
- host 构造不再安装 hook。每个 active capture 持有一份共享 observer 引用，stop、TTL、dispose 都释放；独立 recorder 才持续预采集。首个 recorder 安装会清掉此前按需 host 的缓冲，多个 recorder 采用更保守的限制，host 不能扩大 recorder 的容量、正文或年龄上限。
- fetch 使用原 `arguments` 与 `this` 调原函数，保持单参数调用、同一 Response 和同步异常。Request 使用 clone 的 reader，URLSearchParams/string 支持安全正文；原 Request 正文仍可读取。有界 reader 在解码前按剩余字节切片，cancel 不等待。
- XHR 在原 open/setRequestHeader 成功后才记录元信息；支持 text 与 `responseType=json` 递归脱敏，load/abort/error/timeout listener 在终态、淘汰、过期、stop/dispose 时清理。
- 所有 pagehide 清当前 Document 缓冲、reader、listener 与 hook；persisted pageshow 会由仍存活的 recorder 引用重新同步安装。滚动年龄 timer 会主动淘汰安静页面的过期记录，淘汰同时取消该记录的 clone 观察分支。
- start 在修改旧 capture 前检查 signal；所有 host 入口校验 context 与参数。finished 只在响应安全正文处理完成后出现。默认 documentId 改为绑定当前 Document 的 opaque ID，不再输出页面 URL。
- 六个就近工具测试改为真实参数/context 转发与固定错误验证；新增真实 registry 组合、fetch、XHR、recorder、TTL、pagehide/pageshow、限制隔离、iframe realm 与敏感信息测试。

## 验证

- `pnpm exec vitest run browser-agent/tools/network/src`：11 files / 25 tests 通过。
- `pnpm exec tsc -p browser-agent/tools/network/tsconfig.json --noEmit`：通过。
- `pnpm --filter @einfach-agent/tools-browser-network build`：通过；17 个声明文件生成，11 个文件的 21 处 ESM 说明符已修复。
- `node scripts/check-docs.js`：600 Markdown files 通过。
- `wc -l`：普通源码与测试全部不超过 300 行；最大为 `window-observer.ts` 299 行，`window-host.ts` 247 行。正文 reader/逐记录资源释放拆到 `observer-resources.ts` 60 行。

定向测试覆盖：真实早期 recorder→后建 capture、includeBuffered false、pending 更新、A/B session 隔离、stop/TTL、等待 timeout/abort/stop、直接 host 拒参、start 已取消不替换旧 capture、fetch 原参数/this/Response/Request clone、敏感 URL/JSON/form/header、XHR JSON 与 abort、重复共享 hook/第三方 wrapper、pagehide/BFCache 恢复、滚动过期、不同限制不放大、独立 iframe realm 和 opaque documentId。
