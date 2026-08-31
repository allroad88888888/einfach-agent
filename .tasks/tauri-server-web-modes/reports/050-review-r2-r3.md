# 050 独立复审（R2）

## 结论

**REJECTED**。

R1 的 Rust char/byte-char、嵌套注释与 panic 输出缺口已经补上，ready/token 失败输出脱敏和内容 hash manifest 也仍然成立。但 R2 的 Web AST 守卫尚未覆盖所有声明的计算属性/常量 Tauri root 与非白名单动态 import：`literalText()` 不解包括号或 TypeScript 类型包装；可信插件 import 只检查变量名和实参文本，没有证明 `url` 是 `evaluate` 的参数。require 的 identifier/常见 alias 已被保守拒绝，但 computed global require 仍可绕过。因此验收 2 仍不能通过。

本复审只依据任务文件、R2 执行报告、前两轮审查和三个 untracked 范围文件相对 `/dev/null` 的完整新增 diff。按要求未重跑报告声明的测试。

## R2 重点逐条复核

### 1. 计算属性/常量 Tauri root

❌ **仍不完整。** `desktopStaticGuard.test.mjs` 的 `literalText()` 能求值裸字符串、identifier 常量、`+` 和 template；element access 也已调用该函数，因此报告列出的 `window['__' + 'TAURI__']` 与 `const key = ...; window[key]` 夹具会被拒绝。

但该求值器不解包 `ParenthesizedExpression`、`AsExpression`、`TypeAssertionExpression` 或 `SatisfiesExpression`。例如以下合法 TypeScript 不包含值恰好为 `__TAURI__` 的单个 identifier/string literal，element argument 也会求值为 `undefined`，因而得到空 violations：

```ts
window[('__' + 'TAURI__')].core.invoke('x')
const key = ('__' + 'TAURI__') as const
window[key].core.invoke('x')
```

这同样使后续解构或 invoke alias 可从该 root 继续绕过。R2 夹具只覆盖了未包裹的 binary expression，不能证明“计算属性/常量 Tauri root”整体成立。

### 2. require 与 require alias

❌ **常见 identifier alias 已覆盖，但“所有”仍不成立。** `loadedModule()` 识别直接 `require()`/`require.resolve()`，遍历器又拒绝任意名为 `require` 的 identifier，所以 `const load = require; load(source)`、解构 alias 和包装器中出现 lexical `require` 都会失败。

然而 bracket/computed global access 不含 `require` identifier，当前也没有像 Tauri root 那样检查求值后的 element key。例如：

```ts
const load = globalThis['requ' + 'ire']
load('node:child_process')
```

这里调用 callee 是 `load`，模块名也不会被 `loadedModule()` 识别，整个片段可返回空 violations。若边界要求如 R2 指令所述覆盖所有 require/alias，这仍是直接缺口。

### 3. 非白名单动态 import

❌ **可信入口约束弱于报告声明。** 未知 source 的普通 `import(source)` 会被拒绝，包装函数夹具也有效；静态可求值的 `@tauri-apps/*` 和 `child_process` dynamic import 亦会命中模块规则。

但 `isTrustedPluginImport()` 只确认文件路径、祖先变量名 `evaluate`、实参 identifier 文本 `url`，并未确认 `url` 是 `evaluate` 的形参。以下代码会被计作唯一可信 import，虽然它使用的是自由变量/局部变量，不是报告声称的可信参数入口：

```ts
const url = attackerControlled
const evaluate = () => import(url)
```

同理，`evaluate` 初始化器内嵌套函数中的一次 `import(url)` 也会被放行。数量检查只能保证“恰好一次”，不能补足绑定归属验证。报告所称“参数名 `url`”并未由实现证明。

### 4. Rust char/byte-char 与嵌套注释

✅ **通过。** `rustCharEnd()` 在字符串扫描前识别普通 char 与 `b'…'` byte-char，并处理普通字符、Unicode code point、常规 escape、`\xNN` 与 `\u{…}`；`rustCode()` 对块注释维护嵌套 depth。R2 的 `charFixture` 同时放置 `'"'`、`b'"'` 后的真实 command，`lexerFixture` 覆盖 raw string 与嵌套注释。范围实现中未发现前轮“字符双引号吞掉后续代码”的路径。

### 5. panic / panic_any 输出

✅ **通过。** Rust 扫描在去除字符串/注释后拒绝 word-boundary 的 `panic` 与 `panic_any`；直接 `panic!`、路径调用、import/rename alias 的声明端都会保留这些标识符并命中。`panicFixture` 覆盖 `panic_any as fail; fail(token)`。结合所有 `SidecarError` variant 必须 fieldless 的结构断言，前轮列出的两条错误数据保留路径均已封住。

### 6. ready/token 失败输出脱敏

✅ **通过。** `parseReadyFrame()` 对 JSON、frame 字段、URL、protocol/host/port/token 的所有拒绝均折成固定错误，恶意 URL sentinel 夹具覆盖 URL constructor 失败。`smokeServer()` 丢弃所有内部 cause；聚合器缓冲 stdout/stderr，子检查失败或捕获内容出现 ready kind/`token=` 时只产生固定脱敏错误，顶层 catch 也不转发原始内容。范围 diff 中未发现 token-bearing ready 行或 error cause 进入测试/聚合失败输出的路径。

### 7. 内容 hash manifest

✅ **通过。** `workspaceContentSnapshot()` 始终显式包含三个任务文件，所以它们无论 tracked、dirty tracked 还是 untracked 都会按 path、类型、权限、大小与 SHA-256 内容进入 manifest。声明的 ignored artifact roots 由 `git ls-files -oi --exclude-standard` 枚举；新增、删除、改名或内容/权限变化会改变路径集合或 entry，最终改变 manifest hash。它没有再用 Git porcelain 状态代替内容证据。

该保证按报告明确限定在三个任务文件及声明的 ignored artifacts，不代表整个工作区；在这个声明边界内实现与成功文案一致。

## 验收标准判定

1. ✅ **三种运行模式 smoke：通过。** R2 未改变前轮已通过的核心路径；报告声明纯 Web、浏览器 Node server、bundle 内 Tauri sidecar 为 3/3，两个 child 退出后端口不可用。未重跑，仅核对范围 diff 与声明一致。
2. ❌ **静态守卫与 token 防泄露：不通过。** Rust 与输出脱敏已通过，但 Web 守卫仍有上述 computed Tauri root、computed require alias 和可信 dynamic-import binding 缺口。
3. ✅ **聚合检查及范围内容不变：通过。** 聚合器的失败输出收口与 manifest 内容比较均能支持报告限定范围内的声明；报告所述运行结果未重跑。

## 质量发现

### Critical

无。

### Important

1. **计算属性求值未处理透明语法包装。** 一层括号或 `as const` 即可使拆分构造的 `__TAURI__` 逃过 `literalText()`，随后成员/别名 invoke 不再有独立检查。
2. **可信 dynamic import 没有验证参数绑定。** 名为 `url` 的自由变量或内部局部变量会被误认成 `evaluate` 的可信参数，报告声明的唯一运行时 loader 边界并未真正建立。
3. **computed global require alias 未被识别。** 当前“任意 require identifier 都失败”的保守规则仍覆盖不到求值为 `require` 的 bracket key，因而无法支持“所有 require/require alias”的描述。

### Minor

1. `desktopStaticGuard.test.mjs` 已达 297 行，仍低于普通文件 300 行上限，且可以用一句话描述为“验证 Web/desktop 静态能力边界”；本轮不构成行数或单一职责违规。但任何继续增加夹具/解析规则的改动都会顶破硬上限，修复上述缺口时必须按职责拆分，而不能继续原文件追加。

## ⚠️ 无法核实项

- ⚠️ 按要求未重跑 R2 声明的 `desktop:build`、两个测试、聚合检查、语法检查与 diff check；退出码、3/3 结果和实际控制台输出只能沿用执行报告。
- ⚠️ 未启动真实 Tauri GUI，也未核实窗口关闭事件；任务和报告均把当前 smoke 限定为 bundle 内 sidecar/server-runtime。
- ⚠️ 未检查三个范围文件之外的产品源码或构建产物，因此不能独立确认当前生产源码无违规、现存 `.app` 内容正确或报告列出的 ignored roots 在实际工作区完整存在。

REJECTED Web AST 守卫仍可被透明表达式包装、computed require alias 与未验证绑定的可信 dynamic import 绕过。

# 050 最终独立复审（R3）

## 结论

**REJECTED**。

R2 指出的透明表达式包装与可信插件直接箭头参数绑定已经修复；报告列出的裸 computed global require、常量 key 及计算解构 alias 夹具也会被当前实现拒绝。内容 hash manifest 已纳入拆出的 helper，ready/token 失败输出脱敏亦未见退化。

但 Web AST 的所谓“常量”表仍按标识符文本全文件收集，既不要求 `const`，也不跟踪后续赋值或词法 binding。它因此仍可把运行时变化的 import 参数误判成静态模块，并可让 computed global require alias 继续通过。验收 2 要求其他不可静态求值的 `import()` 与任何 require/computed alias 均被拒绝，当前实现仍不能证明该边界。

本复审只依据任务文件、R3 执行报告、前三轮审查与四个 untracked 范围文件相对 `/dev/null` 的完整新增 diff。按要求未重跑报告声明的测试。

## R3 重点逐条复核

### 1. 透明表达式包装

✅ **通过。** `webCapabilityStaticAnalysis.mjs:13-25` 对括号、`as`、类型断言、`satisfies`、non-null 与 partially-emitted expression 递归解包；`literalText()` 的字符串、identifier、拼接与 template 求值均先经过该解包。`:28-34` 还会向外跨过同一组透明 wrapper，供可信 import 的直接 body 关系检查使用。`desktopStaticGuard.test.mjs:149-152` 覆盖括号、`as const`、类型断言及 `satisfies` 的 Tauri root 反例。R2 列出的透明包装绕过已封住。

### 2. computed global require / alias

❌ **仍不完整。** `webCapabilityStaticAnalysis.mjs:116-121,150-151` 会拒绝可由 `literalText()` 求值为 `require` 的 element access 和 computed property name，因此报告中的直接拼接、单一常量 key 与计算解构 alias 夹具确实成立。

然而 `:127-135` 把任意 variable declaration 的初值写入一个以名称为 key 的全文件 `Map`，不区分 `const`/`let`/`var`，不处理赋值，也不区分词法作用域。以下合法代码中，运行时 property key 为 `require`，但 map 仍保留初值 `safe`；调用端又只剩 `load`，不存在会被 `:150` 命中的 `require` identifier，因此可返回空 violations：

```ts
let key = 'safe'
key = 'require'
const load = globalThis[key]
load(source)
```

同理，先声明 `const key = 'require'`、再在后置内层作用域声明同名 `const key = 'safe'`，也会因后收集的同名 binding 覆盖 map 而漏掉前一处 computed access。这仍是任务明确要求拒绝的 computed global require alias。

### 3. 唯一 `pluginImportModule.evaluate` 的直接箭头参数 binding

✅ **通过。** `webCapabilityStaticAnalysis.mjs:84-113` 要求未知动态 import 位于唯一可信路径，只有一个 identifier 实参，import（允许透明 wrapper）必须正好是箭头函数的表达式 body；箭头只能有一个名为 `url` 的 identifier 参数，实参文本必须与该参数相同；箭头还必须是名为 `evaluate` 的变量声明之 `??` 右侧 fallback。`:137-166` 对可信箭头计数并要求恰好一个。由于 import 是该箭头的直接表达式 body，其 `url` 不存在可插入另一词法 binding 的内部作用域；自由变量、错误实参与嵌套函数三个 fixture 均会被拒绝。R2 的 binding/direct-body 缺口已修复。

### 4. 其他不可静态求值的动态 import

❌ **不通过。** 与 computed require 相同的常量表问题还会把实际动态 import 误判为静态。以下代码在运行时加载攻击者提供的值，但 `collectConstants()` 记录的仍是 `./safe.js`，于是 `loadedModule()` 得到一个非敏感“静态”模块名，既不会进入可信插件检查，也不会产生 violation：

```ts
let target = './safe.js'
target = attackerControlled
import(target)
```

这直接违反任务“其他不可静态求值的 `import()` 全部拒绝”的要求。当前夹具只覆盖无初值可求值的 wrapper 参数，没有覆盖 mutation 或同名 binding。

### 5. 内容 hash manifest

✅ **通过。** `check-desktop-wrapper.mjs:10-18` 已把四个任务文件（含新 helper）显式列入 snapshot，因此这些文件无论 tracked、dirty tracked 或 untracked，都会进入 manifest；`:22-30,56-66` 枚举声明的 ignored artifact roots，并按 path、类型、权限、大小与 SHA-256 内容生成有序 manifest。新增、删除、改名、权限或字节变化都会改变快照或令读取失败。R3 拆分没有退化 R2 的内容不变保证。

### 6. ready/token 脱敏

✅ **通过。** `threeModeSmoke.test.mjs:22-53` 对 JSON、frame 与 URL 校验失败统一返回固定消息；`:146-155` 收口 server smoke 内部异常；`:121-123,172-174` 检查 stderr 不含已解析 token 且 stdout 只有 ready 单行。聚合器 `check-desktop-wrapper.mjs:69-90,107-110` 缓冲输出，遇到失败或 token/ready 标记只产生固定脱敏错误。范围 diff 中未发现原始 ready URL、token 或 child error cause 新增到失败输出的路径。

## 验收标准判定

1. ✅ **三种运行模式 smoke：通过。** 报告声明纯 Web、浏览器 Node server、bundle 内 Tauri sidecar 为 3/3，两个 child 退出后端口不可用；R3 未改动该文件，范围实现仍与前三轮通过结论一致。运行结果未重跑。
2. ❌ **静态守卫与 token 防泄露：不通过。** 透明 wrapper、可信箭头 binding、Rust 边界及 token 脱敏可通过本轮代码复核；但 mutation/同名 binding 会绕过非静态 import 与 computed require alias 禁令。
3. ✅ **聚合检查及范围内容不变：通过。** helper 已加入内容 manifest，ignored artifacts 策略及脱敏聚合未退化；报告所述实际退出码未重跑。

## 质量发现

### Critical

无。

### Important

1. **常量求值器不具备 binding 与 mutation 语义。** `constants` 以名称为唯一 key，接受所有 variable declaration 的初值，忽略声明种类、写操作、声明顺序及作用域。该单一根因同时造成非白名单动态 import 与 computed global require alias 的确定性漏检，验收 2 不能成立。应只采信可证明不可变且与使用点绑定一致的声明，或在无法证明时保守拒绝。

### Minor

无。

## 文件职责与行数

✅ `wc -l` 物理行计数为 218、209、169、110，四个文件均不超过普通文件 300 行上限。三态 smoke、静态守卫的测试/fixture 编排、Web AST 分析、聚合快照与执行分别可用单一职责描述；拆分符合任务指定边界，未发现按行数机械切分或职责大杂烩。

## ⚠️ 无法核实项

- ⚠️ 按要求未重跑 R3 报告声明的两个测试、聚合检查、语法检查与 diff check；退出码、3/3 结果和实际控制台输出只能沿用执行报告。
- ⚠️ R3 未 clean rebuild desktop bundle；现存 `.app` sidecar 是否对应当前源码不能由限定 diff 独立确认。
- ⚠️ 未启动真实 Tauri GUI，也未核实系统窗口关闭事件；当前证据仍限定为 bundle 内 Node/server runtime。
- ⚠️ 未读取四个范围文件之外的产品源码或构建产物，因此不能独立确认生产 Web 扫描结果、当前 bundle 内容或 ignored artifact 实际集合。

REJECTED 常量表忽略 mutation 与词法 binding，仍可放过非静态 import 和 computed global require alias。
