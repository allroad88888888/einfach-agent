# 120 R1 独立复审

结论：**REJECTED**。R1 已修复上轮敏感键、按需 hook 生命周期、fetch 参数转发、Request clone、XHR JSON、pagehide/BFCache 恢复、有界 reader、工具测试排版等问题；但共享 observer 的实例限制和旧请求隔离仍不满足完整合同，并有直接 host 非法参数未受控的问题。

## Critical

无。

## Important

1. `browser-agent/tools/network/src/window-observer.ts:24-40`、`:199-236`，`browser-agent/tools/network/src/window-host.ts:30`、`:55-63` — 正文只按共享 observer 的单个 `maxBodyChars` 读取和脱敏，capture 自己的 `limits.maxBodyChars` 从未用于输出。两个按需 host 同时存在时，后加入的 host 不会调整 observer 参数：若 64 KiB host 先启动、1 KiB host 后启动，低上限 host 会收到最多 64 KiB 的正文；反序则高上限 host 被静默压到 1 KiB。相同问题也出现在低上限 host 加入已有高上限 recorder 时。R1 测试只覆盖“小 recorder + 大 host”这一种顺序，未覆盖完整多 host 参数合同。共享 hook 可以共用，但每个 capture 的公开正文上限必须在复制/返回前独立执行，不能由首个使用者决定。

2. `browser-agent/tools/network/src/window-observer.ts:29-33`、`:199-236`、`:267-275`、`:284-298`，`browser-agent/tools/network/src/window-host.ts:96-102` — 首个 recorder 加入现有按需 observer 时直接 `records.length = 0`，没有对旧记录执行 `cleanupRecord`。旧 fetch 的 response/request clone reader 完成后，`finishFetch` 和 `captureRequestBody` 也没有在 await 后再次确认记录仍属于 observer，仍会 `emit`。因此 recorder 安装前已经开始、清缓存时仍 pending 的请求，会在安装后作为迟到更新进入 recorder 和默认 buffered capture；被滚动过期/容量淘汰的旧 fetch 同样可能发出迟到更新，并被后来 `includeBuffered:false` 的 capture 当成新请求。R1 要求明确禁止迟到更新重新插入 recent 缓冲/新 capture。清空路径应逐记录清理，异步完成路径须在每次 await 后确认记录仍存活再写入/广播。

3. `browser-agent/tools/network/src/window-observer.ts:29-37`、`:75` — observer 的限制在 recorder 加入时可从较大 `maxAgeMs` 降低，但滚动 prune interval 只在 observer 创建时依据初始值计算，之后从不重建。典型情况是 active host 先以 10 分钟创建 observer，再安装 `maxAgeMs: 1` 的 recorder；记录虽然名义上改为 1 ms，安静页面仍可能等原 30 秒 interval 才从内存删除。多个 recorder 后加入更短年龄也一样。参数变更时应重设清理 timer，才能兑现每个 recorder 的滚动保留上限。

4. `browser-agent/tools/network/src/window-host.ts:206-217`、`:219-233` — 公开 host 的直接参数校验仍依赖 truthiness/coercion。`startCapture({ methods: null })` 和 `{ methods: 0 }` 会被接受；`listRequests`/`waitForRequest` 的数值 `method` 可通过正则的字符串强制转换，随后在 `matches` 的 `input.method.toUpperCase()` 抛出原生 `TypeError`。合同要求所有直接 host 非法参数受控返回 `INVALID_INPUT`，不能靠 schema 或运行时异常。应对可选字段在非 `undefined` 时先做精确类型检查，并覆盖 null、数字、NaN 等直接调用。

## Minor

1. `browser-agent/tools/network/src/window-observer.ts:184-197`、`:284-298` — Request clone 正在异步读取正文时，初始 `requestBodyState` 仍是 `omitted`，随后才跳到 `captured/omitted`；公开类型已有 `pending` 状态，当前结果会让早期 `getRequest` 把“尚未读完”误报成“不会捕获”。开始 clone reader 时应标成 `pending`。

## 验证记录

- 按 R1 复审要求未重复运行报告中已通过的 11 files / 25 tests、TypeScript、build 或 docs。
- 本轮结论来自 `reports/120-r1-scope.diff` 与当前源码的逐条合同审查；没有新增临时复现，因此没有新增测试日志。
- 当前普通源码/测试行数符合任务上限；`window-observer.ts` 为 299 行，未复现早先读取过程中出现的暂态行数。
