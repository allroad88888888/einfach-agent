# 120 R3 实施报告

状态：DONE。仅处理 R2 复审剩余的共享页面预缓冲上限问题；未提交、未安装依赖、未启动浏览器或 CDP。

## 修复

- `window-observer.ts`：首个 recorder 接入按需 observer 时清空旧记录并精确采用 recorder 限制；已有 recorder 时，后续 recorder 对条数、正文和年龄只取更保守的最小值，普通 host 不再扩大 recorder 的共享预缓冲限制。
- 收紧限制会立即重新约束已有正文、裁掉超量或过期记录，并在年龄变化时重设清理 timer。JSON 正文超过新上限时按既有安全规则整体省略，不截断为不可解析内容。
- `request-input.ts` 与 fetch response 异步读取在回写时重新读取当前正文上限，避免读取期间加入较严 recorder 后写回超限正文；原有存活检查与清理路径保持不变。
- README 明确多个 recorder 使用更保守限制、普通 host 不会扩容以及释放时不主动回宽。

## 回归覆盖

新增 `recorder-limits.test.ts`，使用真实 recorder、host 与 fetch 覆盖：

- recorder → 宽 host，并在共存后继续请求、停止宽 capture、重新读取预缓冲；
- 宽 host → recorder，确认 recorder 接管时清除旧按需记录并采用自身限制；
- 小 recorder → 大 recorder；
- 大 recorder → 小 recorder，含已经存储的 JSON 正文立即省略；
- pending response 在上限收紧后完成，只按新上限回写。

原 R2 的无 recorder 双 host 顺序、迟到记录存活检查、滚动过期与容量淘汰测试继续通过。

## 验证

- `pnpm exec vitest run browser-agent/tools/network/src`：14 files / 38 tests passed（`120-r3-vitest.log`）。
- `pnpm exec tsc -p browser-agent/tools/network/tsconfig.json`：通过（`120-r3-tsc.log`）。
- `pnpm --filter @einfach-agent/tools-browser-network build`：通过（`120-r3-build.log`）。
- `node scripts/check-docs.js`：607 Markdown files passed（`120-r3-docs.log`）。
- 普通源码与测试均未超过 300 行；`window-observer.ts` 现为 298 行。
