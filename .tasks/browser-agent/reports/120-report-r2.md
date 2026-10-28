# 120 网络工具 R2 修复报告

## 四项 Important 修复

1. capture 在复制 observer record 时按自身 `maxBodyChars` 再执行安全输出限制。text/plain 与已脱敏表单可按实例截断；JSON 等结构化正文超过实例上限时整段 omitted。共享 observer 只扩大采集能力，不能扩大任一 capture 的公开输出。大 host→小 host、小 host→大 host、recorder→小 host 三种加入顺序均有真实 fetch 回归。
2. 首个 recorder 加入既有按需 observer 时，对清除的每条 record 执行资源 cleanup。fetch response 与 Request clone 的每个 await 后都会复核当前 Document 与 record 存活；过期、容量淘汰或 recorder 代次切换后的迟到结果不会写回或 emit。新增 first-recorder、滚动过期、容量淘汰三条 deferred-response 回归。
3. recorder 缩短共享 observer 的 `maxAgeMs` 时立即 prune，并清除旧 interval、按新年龄重建滚动 timer。fake-timer 回归从已有 host observer 接入 1ms recorder，证明安静页面在新周期清除记录。
4. host 直接调用对 `methods` 和 `method` 做非 `undefined` 后的精确类型校验。null、0、NaN、object 与非法数组统一抛 `INVALID_INPUT`，不再进入正则隐式转换或 `toUpperCase` 原生异常。

同时修复 Request clone 开始读取时的 `requestBodyState:'pending'`，并新增未完成 stream 正文回归。capture 的 pending tombstone 只记录仍可能迟到更新的 pending request，完成更新即删除，并硬限制为共享 observer 最大容量 500，避免 capture TTL 内随总请求数无界增长。包内 `test` 脚本现从仓库根明确运行 `browser-agent/tools/network/src`，不会从包 cwd 扫描全仓。

## 验证

- `pnpm exec vitest run browser-agent/tools/network/src`：13 files / 33 tests 通过。
- `pnpm --filter @einfach-agent/tools-browser-network test`：13 files / 33 tests 通过，root 与目标路径正确。
- `pnpm exec tsc -p browser-agent/tools/network/tsconfig.json --noEmit`：通过。
- `pnpm --filter @einfach-agent/tools-browser-network build`：通过；18 个声明文件生成，13 个文件的 24 处 ESM 说明符已修复。
- `node scripts/check-docs.js`：603 Markdown files 通过。
- 普通 source/tests 全部不超过 300 行；最大 `window-observer.ts` 294 行，`window-host.ts` 285 行。

R2 新增有效回归覆盖每实例正文限制的三种加入顺序、三类 late pending 隔离、短年龄 timer 重设、直接调用非法类型矩阵和 Request clone pending 状态；保留并继续通过 R1 的 25 项测试。
