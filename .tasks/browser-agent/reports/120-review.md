# 120 独立审查

结论：**REJECTED**。定向执行 `pnpm exec vitest run browser-agent/tools/network/src` 为 7 files / 10 tests 通过，但现有测试没有覆盖完整 host/recorder 合同；实现存在凭据泄露、生命周期、原调用语义和 XHR 正文处理缺陷。

## Critical

1. `browser-agent/tools/network/src/sanitize.ts:1`、`:8`、`:40`、`:50` — 敏感键仅按少量完整字符串匹配，常见凭据键 `client_secret`、`refresh_token`、`auth_token`、`session_id` 等不会脱敏，会原样进入 URL、JSON 或 urlencoded 正文缓存并通过工具返回。合同要求 token / secret / session 等敏感参数和递归正文键先脱敏；当前实现会直接泄露真实 OAuth 等凭据。应按规范化后的敏感组成词/明确完整名单覆盖常见变体，并补 URL、JSON、表单回归。

## Important

1. `browser-agent/tools/network/src/window-host.ts:11-13`、`:26`、`:38`、`:41`、`:63` — host 构造时立即 `retainObserver`，而 stop/TTL 只取消 capture 订阅；直到整个 host `dispose()` 才释放观察器。因此未安装 recorder 时也会从 host 构造开始缓存 start 之前的请求，stop/TTL 后仍包装 fetch/XHR 并继续缓存。它同时违反“未安装 recorder 时按需模式”、`includeBuffered` 只读取 recorder 授权早期缓存，以及 stop/TTL 真正卸载的合同。按需 host 应只在 active capture 期间持有 hook，独立 recorder 才能跨 capture 持续监听。

2. `browser-agent/tools/network/src/window-observer.ts:26-28`、`browser-agent/tools/network/src/window-host.ts:11-13` — 同一 Window 上所有使用者的限制用永久 `Math.max` 合并，释放使用者时也不重算。任一 host 会把 recorder 默认 5 分钟的 `maxAgeMs` 提升到 10 分钟；高 `maxBodyChars` host 也会让低上限 recorder/host 保存并返回更大的正文。该行为破坏每个公开实例的有界/保留合同，也让一个共享 host 改变其他 host 的数据暴露范围。共享 observer 需保留每个订阅者参数，按消费者做快照/正文限制，或在引用变更时正确重算有效限制。

3. `browser-agent/tools/network/src/window-observer.ts:57-70`、`:117-123` — fetch 包装总以 `[input, init]` 两个参数调用原函数，即页面只传一个参数时也新增显式 `undefined`，没有保持原参数列表；请求正文仅捕获字符串 `init.body`，`Request` 对象正文以及 Blob、URLSearchParams 等均直接标为 omitted。合同明确要求保持原 this/参数且不消费原 Request body，并重点要求 Request body 保留。应转发真实 `arguments`，从 clone 有界读取支持的 Request/body 类型，且观察失败不得改变原调用。

4. `browser-agent/tools/network/src/window-observer.ts:136-141` — XHR 只读取 `responseType === '' | 'text'`，`responseType='json'` 一律返回 omitted，尽管 JSON 已由浏览器安全解析且是合同明确点名的场景。应对 json 响应做同一递归脱敏和大小/深度限制，并补复用、abort/error/timeout、同步 XHR 和 json responseType 验收。

5. `browser-agent/tools/network/src/window-observer.ts:104-105`、`:145` — `pagehide.persisted` 时完全跳过清理，与 recorder 生命周期“跟随当前 Document/pagehide”不符；过期记录也只有新请求或 snapshot 时才 prune，没有滚动过期 timer。页面进入 bfcache 后包装、缓存和 reader 可继续存活，安静页面的过期记录也不会按时从内存删除。应在所有 pagehide 路径释放当前 Document 资源，并为滚动过期提供可清理的定时机制。

6. `browser-agent/tools/network/src/window-observer.ts:125-134`、`:147` — 所谓有界读取按解码后的字符数判断，但每次先对完整网络 chunk 执行 `decoder.decode(next.value)`；单个超大 chunk 仍会一次性解码/分配完整字符串，不能满足“不能直接无界读取”的内存边界。应在解码前按剩余字节预算切片，并明确处理多字节字符边界。

7. `browser-agent/tools/network/src/get-network-request/get-network-request.test.ts:1-2`（同样适用于其余五个 tool 测试）及 `browser-agent/tools/network/src/window-host.test.ts:9-61` — 六个工具测试都只有两行，使用 `{} as never` 只断言工具名；唯一 host 测试仅 4 项。没有真实 registry→factory、Request/原参数/同 Response/同步异常、请求正文、容量/TTL/淘汰、多个 host 参数、重复 recorder/pagehide、pending 继承、XHR、导航/iframe 等合同证据，并明确违反任务要求的“正常多行排版，不能用 2 行承载整个测试”。报告中的“7 files / 10 tests”不能替代这些验收，必须补真实行为测试并恢复正常排版。

## Minor

1. `browser-agent/tools/network/src/window-observer.ts:57-147`、`browser-agent/tools/network/src/window-host.ts:17-77` — 大量完整函数和控制流压成单行，虽物理行数分别只有 147/77，实际复杂度远高于报告的“最大新增源码 147 行”，也违反本任务普通 source 正常多行排版约束，妨碍审查和行数门禁发挥作用。应正常格式化并按 observer hook、正文读取、capture 生命周期/校验等职责拆分。

## 验证记录

- `pnpm exec vitest run browser-agent/tools/network/src`：7 files / 10 tests 通过。
- `pnpm --dir browser-agent/tools/network test` 实际从仓库根启动 Vitest，并非只运行 network 包。该次已返回输出中可见失败为：`scripts/subagent-skill-governance.test.js` 24/24（包括只读默认、冲突 action、promote/archive、malformed state/audit、各 crash/recovery 点、锁与外部修改保护）；`scripts/agent-rollout-rebuild.test.js` 1/11（`leaves SQLite unchanged in dry-run and rebuilds only with --write`）；`packages/host-node/src/rollout/rolloutRecovery.integration.test.ts` 2/4（双进程批次串行化、source fsync 与 projection 间终止后的精确恢复）；`packages/host-node/src/rollout/service.test.ts` 1/12（跨进程 equivalent backfill 去重）；`scripts/check-boundaries.test.js` 16/16；`scripts/subagent-archive-retention.test.js` 4/5；`packages/host-node/src/rollout/jsonlStore.test.ts` 1/9（独立 writer 进程协调）。输出还包含一次 Node `PromiseRejectionHandledWarning`，但在已返回片段中没有 Vitest 的最终汇总或 `Unhandled Errors` 统计，不能据此断言 unhandled error 数量。该次输出没有另存日志文件，现有证据仅为本次工具调用返回内容；未对照前态，故不对上述失败作“既有/无关”归因，也不将它们作为 120 产品通过或失败证据。
