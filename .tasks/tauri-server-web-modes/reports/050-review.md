# 050 独立审查

## 结论

**REJECTED**。

三种运行方式的 smoke 在范围代码中是实际不同的：纯 Web 不启动 child，浏览器 server 使用当前 Node 与 `apps/server/dist/main.js`，Tauri sidecar 使用 `.app` 内 Node 与 `Resources/server/main.js`。但验收 2 的静态守卫可被常见语法绕过，也不能可靠证明敏感 ready/error 数据不会被捕获；验收 3 仅比较 Git porcelain 状态，不能证明工作区文件内容没有变化。

本审查只依据任务文件、执行报告和指定范围 diff。报告声明的测试结果未重跑。

## 验收标准判定

### 1. 三种运行模式 smoke

✅ **通过。** 执行报告声明 `node apps/desktop/tests/threeModeSmoke.test.mjs` 退出码为 0、3/3 通过；范围 diff 与该声明一致：

- `threeModeSmoke.test.mjs:154-161` 用 404 health 响应验证纯 Web 解析为 `{ kind: 'static' }`，并在前后断言 `runningChildren.size === 0`。
- `threeModeSmoke.test.mjs:163-167` 使用 `process.execPath` 和 `apps/server/dist/main.js` 启动浏览器 Node server。
- `threeModeSmoke.test.mjs:169-173` 使用 `.app/Contents/MacOS/einfach-agent-node` 和 `.app/Contents/Resources/server/main.js` 启动 bundle 内 sidecar server。它与浏览器 Node server 是不同的可执行文件及脚本产物，不是把同一个 handle 重命名为第三态。
- `threeModeSmoke.test.mjs:99-113` 对两个 server 都检查真实 `/api/health` payload，并调用同一个真实打包后的 `resolveHost()`，期望 `{ kind: 'server', platform }`。
- `threeModeSmoke.test.mjs:115-140` 等待 child 的 `exit`，随后轮询 health URL，确认端口不可用。

这里的“三态”是三种运行方式，不是三个 `HostKind` 值；结果按任务上下文仍应只有 `static | server`。该 smoke 直接运行 bundle 内 sidecar 产物，并未启动 Rust/Tauri GUI wrapper；执行报告已明确这一边界，任务验收文本本身没有要求 GUI 级启动。

### 2. 静态守卫与 token 防泄露

❌ **不通过。** 执行报告声明 `node apps/desktop/tests/desktopStaticGuard.test.mjs` 退出码为 0、2/2 通过，但当前守卫只能证明现有文本没有命中几组启发式规则，不能可靠保证验收所列禁令：

- `desktopStaticGuard.test.mjs:39-76` 只识别静态 `import`/`export` 的 `@tauri-apps/` module specifier。动态 `import('@tauri-apps/...')`、`require('@tauri-apps/...')` 等不会命中。
- 全局 invoke 仅识别名称正好为 `invoke`、且 `getText()` 包含 `__TAURI__` 的属性访问；`window.__TAURI__.core` 上的计算属性调用、解构或别名调用可绕过。
- `desktopStaticGuard.test.mjs:91-93` 对 `child_process` 使用原始文本正则。它会扫描注释/普通字符串而产生误报，同时漏掉动态 import、`require()`、side-effect import 等常见形式。
- `desktopStaticGuard.test.mjs:79-81` 在解析 Rust 前用正则删除注释，并不理解 Rust 字符串或嵌套块注释。字符串中的 `//` 可把同一行后续真实代码一并删掉，形成直接绕过。
- `desktopStaticGuard.test.mjs:103-105` 仅在打印宏的浅层文本里搜索字面量 `ready|token`；打印名为 `url`、`frame`、`server` 或 `error` 的敏感值不会命中。
- `desktopStaticGuard.test.mjs:109-112` 只在 `SidecarError` enum body 中禁止 `String|str|Url|ReadyServer` 这几个类型名。自定义 wrapper、`Box<dyn Error>`、`anyhow::Error` 或包含敏感数据的其他结构都能通过，因而不是对 error capture 的传递性保证。

范围 smoke 对正常路径有两项有效保护：`threeModeSmoke.test.mjs:95` 和 `:130` 检查 child stderr 不含 token，`:131` 检查 stdout 只有一行 ready frame。但这些动态检查不能补足静态守卫的绕过面。

### 3. 聚合检查通过且工作区不变

❌ **不通过。** 执行报告声明 `node scripts/check-desktop-wrapper.mjs` 退出码为 0，且前后 porcelain 字节相同；聚合脚本也确实顺序执行两项 smoke，并在失败后仍采集 after 状态。

然而 `check-desktop-wrapper.mjs:14-21` 的 `workspaceState()` 只保存 `git status --porcelain=v1 -z --untracked-files=all`。该输出记录路径及状态，不记录文件内容。以下修改可在 before/after 完全相同的情况下发生：

- 改写一个本来就已是 `M` 的 tracked 文件，但仍保持 `M`；
- 改写一个本来就 untracked 的文件，但仍保持 untracked；
- 改写 ignored 文件或 ignored 构建产物，它们根本不在该快照中。

因此 `check-desktop-wrapper.mjs:39` 的相等断言不能支持 `:41` 所声称的“without modifying workspace files”。从范围代码看，smoke 自己把 esbuild 输出和临时 home 放在系统临时目录，未看到明确的工作区写入；但按要求不重跑测试，当前实际运行是否产生任何范围外副作用只能标为 ⚠️，而脚本的“不变”判据本身确定不充分。

## 质量发现

### Critical

无。

### Important

1. **静态边界守卫可被常见语法绕过。** 动态 import/require、全局 invoke 的 bracket/alias 调用、Rust 变量间接打印以及敏感错误 wrapper 均未被覆盖。这会让 Web 获得 Tauri/Rust 能力或让 token 进入错误数据时，检查仍退出 0。证据见验收 2。

2. **工作区不变检查只比较 Git 状态，不比较内容。** 对已 dirty、untracked 或 ignored 文件的改写可以静默通过，聚合命令的成功消息因此过度声明。证据见验收 3。

3. **⚠️ token 在失败输出路径仍有潜在暴露面。** `threeModeSmoke.test.mjs:60-88` 把完整 token-bearing ready 行保存在 `stdout`，`:91-96` 在未统一清洗错误对象的情况下解析 URL；若 `new URL(frame.url)` 抛错，错误对象可能携带原始 input。随后 `check-desktop-wrapper.mjs:28-29` 会无条件转发子测试的 stdout/stderr。正常成功路径没有打印 token，执行报告也声明本轮输出未泄露；但范围代码没有建立“所有失败路径均脱敏”的保证，因此此项无法仅凭现有材料完全核实。

### Minor

1. `child_process` 的原始文本正则会扫描注释与字符串，可能仅因文档示例触发失败；这与同文件其他基于 TypeScript AST、自然忽略注释的规则行为不一致。

## 文件职责与行数

✅ 三个新增文件分别为 178、117、49 行，均低于普通文件 300 行上限。`threeModeSmoke.test.mjs` 负责三运行方式 smoke，`desktopStaticGuard.test.mjs` 负责 desktop/Web 能力边界守卫，`check-desktop-wrapper.mjs` 负责聚合执行，未发现机械拆分或明显职责混杂。

## 修复后复审重点

- 使用 AST/语义完整覆盖静态 import、动态 import、require、side-effect import，以及 global invoke 的 bracket/alias 形式；Rust 侧避免正则删注释后再扫描，并对敏感数据流/error 类型采取不可绕过的结构约束或针对真实类型的测试。
- 工作区不变检查至少对 tracked、untracked 目标内容做哈希/字节快照，并明确 ignored 构建产物的策略；不能再用 porcelain 路径状态等同文件内容。
- 对 ready URL 解析及所有失败转发路径统一脱敏，保证 test runner 或聚合脚本输出错误时也不会包含 token。

# 050 独立复审（R1）

## 结论

**REJECTED**。

首轮关于 ready/token 失败输出和内容快照的 Important 已修复；动态 import、直接 require 以及报告列出的 invoke alias 夹具也确实新增了 AST 覆盖。但验收 2 仍未成立：Web 守卫可被静态可知的计算属性绕过，Rust 词法器会把字符字面量中的双引号误当成字符串起点并吞掉其后真实代码，且 Rust 输出检查仍未覆盖 panic 输出路径。

本复审只依据任务文件、R1 执行报告、首轮审查和三个 untracked 范围文件相对 `/dev/null` 的完整新增 diff。按要求未重跑报告已声明的测试。

## 首轮 Important 逐条复核

### 1. 静态边界守卫：动态 import / require / invoke / Rust 错误输出

❌ **仍不通过。** R1 有实质改进，但存在可以直接构造的漏检：

- ✅ `desktopStaticGuard.test.mjs:57-75` 已统一识别静态 import、side-effect import、re-export、import-equals、直接动态 `import()`、直接 `require()` 与 `require.resolve()`；`:35-55` 还能求值字符串拼接、模板和顶层常量。`:180-196` 的相应反绕过夹具与实现一致。
- ❌ `desktopStaticGuard.test.mjs:98-101` 只禁止值恰好等于 `__TAURI__` 的单个 identifier/string literal，没有对属性名调用 `literalText()`。合法代码 `window['__' + 'TAURI__'].core.invoke('x')` 或 `const key = '__' + 'TAURI__'; window[key].core.invoke('x')` 中不存在单个 `__TAURI__` 节点，会得到空 violations。成员/别名 invoke 因此仍可从计算出的 root 绕过。
- ❌ `desktopStaticGuard.test.mjs:116-161` 没有识别 Rust char/byte-char literal。合法 Rust `let quote = '"'; #[tauri::command] fn leak() {}` 中，扫描器会从字符字面量里的 `"` 开始按普通字符串一直扫描到文件末尾，从而吞掉真实 command；同一技巧也能隐藏输出 sink。现有 lexer fixture 只覆盖 raw string 与嵌套块注释，未覆盖字符字面量。
- ❌ `desktopStaticGuard.test.mjs:164-173` 的输出 sink 规则未禁止 `panic!`/`panic_any`。例如 `panic!("{}", token)` 在去除字符串后仍不会产生 violation，但 panic payload/诊断正是错误输出路径，可以保留或打印 token。
- ✅ `desktopStaticGuard.test.mjs:208-216` 要求 `SidecarError` 的所有 variant 为 fieldless，已封住首审列出的 `String`、自定义 wrapper、`Box<dyn Error>`、`anyhow::Error` 作为 enum field 的绕过。这个约束有效，但不能补足上述词法吞码与 panic 输出漏洞。

另外，动态 import/require 仍只覆盖该分析器可求值的直接调用；`const load = require; load('@tauri-apps/api/core')`、包装函数内 `import(specifier)` 等会漏检。R1 报告已经承认运行时计算模块字符串无法静态证明，因此不能把当前实现描述为不可绕过的能力边界。

### 2. dirty / untracked / ignored 内容快照

✅ **通过。** `check-desktop-wrapper.mjs:54-65` 显式把三个任务文件加入 manifest，因此不论它们是 clean、dirty tracked 还是 untracked，都会按路径、类型、权限、大小和 SHA-256 内容参与前后比较。声明的 ignored artifact roots 则通过 `git ls-files -oi --exclude-standard -z` 逐项枚举并哈希；新增、删除、改名、权限或字节变化都会改变 manifest，或使快照读取失败。它不再用 porcelain 状态代替内容证据。

该保证有意只覆盖任务 files 与声明的 ignored roots，不是整个工作区；这与任务的“范围文件”及 R1 报告所声明边界一致。

### 3. ready/token 的失败输出脱敏

✅ **通过。** 范围代码已经形成两层脱敏：

- `threeModeSmoke.test.mjs:22-52` 捕获 JSON 与 URL 构造错误，并把所有 frame 校验失败折成固定消息；`:131-140` 又把 server smoke 内未知异常统一折成固定消息。恶意 URL sentinel 夹具直接覆盖了首审指出的 `new URL(frame.url)` 风险。
- `check-desktop-wrapper.mjs:68-87` 缓冲子进程输出；子检查失败，或输出含 ready kind/`token=` 时，只拒绝固定脱敏错误，不转发捕获内容。`:102-105` 的顶层失败输出也固定脱敏。

成功路径不会主动输出已捕获的 ready frame；child stderr 中出现已知 token 或 stdout 多于 ready 单行会先令 smoke 失败，再由上述两层固定消息收口。仅依据范围 diff，未发现首审所述原始 ready URL/error cause 被转发的路径。

## 质量发现

### Critical

无。

### Important

1. **Web 的计算属性可绕过 Tauri root 禁令。** `__TAURI__` 被拆成字符串表达式后不会命中节点级等值检查，随后成员或别名 invoke 均可执行；验收 2 所要求的成员/别名调用边界仍不可靠。
2. **Rust 词法器可被字符字面量破坏。** 字符字面量里的双引号会使扫描器吞掉后续真实 Rust，导致 command、invoke handler 或输出 sink 漏检。
3. **Rust panic 错误输出未受控。** fieldless `SidecarError` 不约束 panic payload；当前 sink 规则不识别 `panic!`/`panic_any`，因此“桌面错误/输出不保留 ready token”仍有直接绕过。

### Minor

1. 动态 import/require 的检测仅跟踪顶层字符串常量，不跟踪 loader 别名、包装调用或其他简单表达式；若项目必须保留运行时插件 import，守卫需要明确可信入口，而不是把所有不可求值调用默认为安全。

## 文件职责与行数

✅ 三个文件分别为 218、228、106 行，均低于普通文件 300 行上限。三运行方式 smoke、静态能力边界守卫、聚合检查各自职责单一，未发现假拆分。

## ⚠️ 无法核实项

- ⚠️ 按要求未重跑 R1 声明的 `desktop:build`、两个测试、聚合检查、语法检查与 diff check；其退出码和运行时输出只能沿用执行报告，不能由本复审独立确认。
- ⚠️ 未启动真实 Tauri GUI，也未核实窗口关闭事件；任务与报告均把本项限定为 bundle 内 sidecar/server-runtime smoke。
- ⚠️ 未检查三个范围文件之外的产品源码，因此只评价守卫能否证明边界，不能确认当前产品源码是否已经使用上述绕过语法。

REJECTED 静态守卫仍可漏掉计算属性 Tauri root、Rust 字符字面量后的真实代码及 panic 敏感输出。

后续 R2/R3 审查记录见 `050-review-r2-r3.md`。
