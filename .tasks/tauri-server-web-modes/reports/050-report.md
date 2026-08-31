# 050 执行报告（R3）

## 改动摘要

- 新增 `apps/desktop/tests/webCapabilityStaticAnalysis.mjs`，将 Web TypeScript AST 能力边界分析从测试编排中拆出；该文件只负责 Web source 的静态能力检查。
- 透明表达式求值现在解包括号、`as`、类型断言、`satisfies`、non-null 与 partially-emitted 表达式；拆分构造的 `__TAURI__` 即使被这些语法包装也会被拒绝。
- computed loader 检查同时覆盖 element access 与 computed property name；求值为 `require` 的属性键会被保守拒绝，因此 `globalThis['requ' + 'ire']`、常量 key 和计算解构 alias 均不能绕过。
- 可信插件动态 import 精确限定为 `apps/web/src/plugins/pluginImportModule.ts` 中 `evaluate` 的 `??` fallback 箭头函数；`import(url)` 必须是箭头函数的直接表达式 body，唯一实参必须绑定到该箭头函数唯一的 `url` 形参。自由变量、其他实参及嵌套函数 import 均被拒绝。
- `apps/desktop/tests/desktopStaticGuard.test.mjs` 保留 fixture、生产扫描及 Rust/desktop 编排，并新增上述三类正反例。
- `scripts/check-desktop-wrapper.mjs` 的内容快照加入新增 Web AST helper，继续保护本任务全部范围文件。
- R3 未修改 `threeModeSmoke.test.mjs` 的既有三态、child 退出及脱敏逻辑。

## 逐条验收命令与结果

1. `node apps/desktop/tests/threeModeSmoke.test.mjs`
   - 结果：退出码 0，3/3 通过。
   - 证据：纯 Web 的缺失 health 解析为 `static`；浏览器 Node server 与 bundle 内 Tauri sidecar 均解析为 `server`；两个 child 退出后端口均不可用。

2. `node apps/desktop/tests/desktopStaticGuard.test.mjs`
   - 结果：退出码 0，3/3 通过。
   - 证据：生产 Web source 无违规；透明包装的 Tauri root、computed require alias、插件 import 自由变量/错误实参/嵌套函数 fixture 均被拒绝；唯一可信的直接参数绑定 fixture 被放行；既有 Rust 输出/error 边界仍通过。

3. `node scripts/check-desktop-wrapper.mjs`
   - 结果：退出码 0；内部三态 3/3、静态守卫 3/3 均通过。
   - 内容不变证据：输出 `desktop wrapper checks passed; task files and declared ignored artifacts are unchanged`；新增 helper 已纳入任务文件 SHA-256 manifest，前后快照一致。

4. `node --check apps/desktop/tests/threeModeSmoke.test.mjs && node --check apps/desktop/tests/desktopStaticGuard.test.mjs && node --check apps/desktop/tests/webCapabilityStaticAnalysis.mjs && node --check scripts/check-desktop-wrapper.mjs`
   - 结果：退出码 0。

5. 对四个范围源文件逐个执行 `git diff --no-index --check /dev/null <file>`
   - 结果：均无 whitespace diagnostics；退出码 1 仅表示 `/dev/null` 与新增文件存在预期差异。

6. `wc -l apps/desktop/tests/threeModeSmoke.test.mjs apps/desktop/tests/desktopStaticGuard.test.mjs apps/desktop/tests/webCapabilityStaticAnalysis.mjs scripts/check-desktop-wrapper.mjs`
   - 结果：218、209、169、110 行；全部不超过普通文件 300 行硬上限。

## 未验证项

- R3 未重新执行 `pnpm desktop:build`；验收使用工作区现存 `.app` bundle。三态 smoke 已实际启动该 bundle 内 sidecar，但未证明从 clean workspace 重建产物。
- 未自动打开真实 Tauri GUI，也未通过系统 UI 事件关闭窗口；当前验收覆盖 bundle 内 Node/server runtime、ready/health 契约及 child 退出后的端口释放。
- 未运行范围外全量 `pnpm test`；index 已记录其被用户删除的 `UndoBar.tsx` 对应 invariant 测试阻塞。
- 未验证 Windows、Linux 或 Intel macOS；本轮目标按 index 固定为 macOS Apple Silicon。

## 范围外发现

- R3 未发现新的范围外问题。
- 沿用 index 的既有发现：bundle identifier `com.webagent.app` warning、Vite 大 chunk/重复 import warning，以及全量测试的 `UndoBar.tsx` 阻塞均未在本任务内处理。

## 疑虑

- Web AST 守卫是保守边界：任意求值为 `require` 的计算属性都会失败，即使它只是普通对象字段。当前生产扫描通过；未来若业务确需名为 `require` 的计算字段，需要先裁决边界，而不能静默放宽。
- 聚合检查消费已有 desktop bundle，不负责构建；060 CI 仍需先运行 desktop build。

## 建议后续动作

- 独立复审优先核对三条 R2 Important：透明表达式、computed require alias、可信插件 import 的参数绑定与直接 body 关系。
- 060 CI 先执行 `pnpm desktop:build`，再执行 `node scripts/check-desktop-wrapper.mjs`。
- 首发前处理 index 已记录的 bundle identifier 裁决；需要 GUI 级最终门时另补真实 `.app` 启动/关闭 smoke。
