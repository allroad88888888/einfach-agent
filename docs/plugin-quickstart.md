# 插件上手：20 分钟写一个外部插件

> 本文是 插件生态与模型 Provider 注册化 issue 树（已完成，全文随 Git 历史归档） P9 卡的判据文档：
> 照着下面的步骤操作，20 分钟内能写完一个第三方插件并在 CLI 里看到它生效——这是
> [插件生态蓝图](plugin-ecosystem-blueprint.md) 第 6 节定的成败标准。
> 已验证（2026-08-13）：从零建目录到 `pnpm cli -v` 打出 `enabled`，实测约 10 分钟，
> 真实输出见「第 4 步」。

## 你会得到什么

一个能被 `pnpm cli` 扫描并加载的最小插件：`plugin.json` 声明身份与能力，一个单文件 ESM
入口用 `definePlugin` 注册一个 run 生命周期 hook（`activate`）和一个模型可见工具
（`install`）。跑起来后 `-v` 输出里会出现：

```
[plugins] acme.hello@1.0.0: enabled
```

跑完的成品放在 [`packages/agent-plugin-example/external/`](../packages/agent-plugin-example/external/README.md)，可以直接复制，也可以跟着下面步骤手写一遍。

## 前置条件

- 已经 `pnpm install` 过本仓库（插件的 `import` 依赖仓库自身的 pnpm 符号链接解析
  `@einfach-agent/core`，见下方「当前边界」第 4 条——插件目录必须放在本仓库工作区内）。
- `~/.webAgent/config.json` 里已经配置了一个模型 Key（CLI 默认用 DeepSeek，对应字段
  `modelCredentials["deepseek:default"]`；没有配置过参见根 `README.md`）。
- 如果 shell 里残留了失效的 `DEEPSEEK_API_KEY`/`GLM_API_KEY`/`KIMI_API_KEY` 环境变量，运行
  CLI 时要用 `env -u` 屏蔽——CLI 按 `apps/cli/src/credentials.ts` 的规则，环境变量优先于配置
  文件，残留的坏 Key 会盖掉配置文件里能用的那个。

## 第 1 步 —— 建插件目录

CLI 扫描 `<workspace>/.webAgent/plugins/` 下的每个子目录
（[`pluginScanner.ts`](../packages/agent-core/src/plugins/pluginScanner.ts)）；目录名任意，
和 manifest 里的 `id` 无关。在仓库根目录执行：

```sh
mkdir -p .webAgent/plugins/hello-plugin
```

## 第 2 步 —— 写 `plugin.json`

写入 `.webAgent/plugins/hello-plugin/plugin.json`：

```json
{
  "id": "acme.hello",
  "name": "Hello 插件",
  "version": "1.0.0",
  "apiVersion": "1.0.0",
  "capabilities": ["tools"],
  "entry": { "core": "plugin.mjs" }
}
```

字段约束（完整规则见
[`manifestTypes.ts`](../packages/agent-core/src/plugins/manifestTypes.ts)）：

- `id`：小写反向域名，至少两段，如 `acme.hello`；不能用保留前缀 `core.` / `web-agent.`。
- `apiVersion`：CLI 当前声明的支持区间是闭区间 `1.0.0`–`1.0.0`
  （[`apps/cli/src/plugins.ts`](../apps/cli/src/plugins.ts) 的 `HOST_API_VERSION_RANGE`），
  写别的值会被判成 `incompatible`。
- `capabilities`：本例只用 `tools`；可选值还有 `hooks`/`commands`/`renderer`/`timeline.persist`，
  但 `timeline.persist` 当前一律拒绝授予（R5 未批准）。
- `entry.core`：插件目录内的相对路径，不能是绝对路径/URL/`..`。CLI 只装 `entry.core`，
  `entry.react` 会被忽略（见「当前边界」第 2 条）。

## 第 3 步 —— 写入口文件

写入 `.webAgent/plugins/hello-plugin/plugin.mjs`（用 `.mjs` 后缀，避免附近没有
`package.json` 时被当成 CommonJS 解析）：

```js
import { definePlugin } from '@einfach-agent/core/plugin'

export default definePlugin({
  install(api) {
    api.registerTool({
      name: 'hello_from_plugin',
      runtime: 'internal',
      skill: {
        description: '返回一句问候，用来验证外部插件已生效。',
        content: '# hello_from_plugin\n\n无参数，返回一条问候语，仅用于验证插件已加载并可被模型看到。',
      },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, data: { message: 'hello from acme.hello plugin' } }
      },
    })
  },
  activate(api) {
    api.observeRun((run) => {
      if (run?.status === 'running') {
        console.error('[acme.hello] run started:', run.runId)
      }
    })
  },
})
```

两点硬规则（[`pluginContracts.ts`](../packages/agent-core/src/runtime/core/pluginContracts.ts)、
[蓝图 3.2 节](plugin-ecosystem-blueprint.md#32-加载协议)）：

- 默认导出（或具名导出 `corePlugin`）必须是 `definePlugin` 的产物，裸对象一律拒绝。
- `registerTool` 只能在 `install` 回调里调用；`install` 返回之后再注册会被拒绝并记诊断，
  top-level 副作用做注册的插件视为不合规。

`activate` 是运行期能力：`api.observeRun` 观察当前 run 的状态投影，`api.onAfterToolCall`
可以观察已完成的工具调用，`api.commands` 暴露受限命令（当前只有
`stopCurrentRun()`）。本例只用了 `observeRun` 来证明 hook 真的跑起来了。

`api.hook(name, fn)` 则是**与仓内插件同一批的 7 个 loop hook 槽**
（[`pluginHookContracts.ts`](../packages/agent-core/src/runtime/core/pluginHookContracts.ts)）：
`onRunStart` / `transformContext` / `prepareRequest` / `beforeToolCall` / `afterToolCall` /
`onTurnEnd` / `shouldStop`。这不是观察面——`beforeToolCall` 返回 `{ block: true, reason }`
会**真的拦下**那次工具执行（模型收到一条 `code: 'plugin_blocked'` 的结果，工具的 `execute`
不会被调用），`transformContext` / `prepareRequest` 拿到的 `draft.messages` 就是模型这一轮
看到的东西，就地改即生效。相应的信任姿态见「当前边界」第 5 条。

```js
api.hook('beforeToolCall', (ctx, ev) => (
  ev.toolName === 'shell' ? { block: true, reason: 'acme.hello 不允许这条命令' } : undefined
))
```

hook 拿到的 `ctx` 是受限投影，只有 `sessionId` / `runId` / `signal` / `isCurrent()`：**没有**
einfach 的 `Store`。会话状态的改动一律走 `api.commands`——会话 atom 的写入必须收口在 core 的
命令层，而磁盘上的插件代码门禁扫不到，这条不随信任姿态一起放开。

## 第 4 步 —— 用 CLI 跑起来

```sh
env -u DEEPSEEK_API_KEY -u GLM_API_KEY -u KIMI_API_KEY pnpm cli -v -p "用一句话介绍你自己" < /dev/null
```

真实输出（2026-08-13 实测，节选）：

```
[plugins] acme.hello@1.0.0: enabled
[plugins]   acme.hello: 1 个模型可见工具默认未启用（hello_from_plugin），需在插件面板逐个勾选
[trace] agent.turn
[acme.hello] run started: fcd6cda1-9596-4d04-bda9-0b3bb0ed5dcb
...
[assistant] 我是运行在这个网页对话环境里的 AI 助手，可以帮你解答问题、读取并讲解本工作区的技能与文档，并在需要时调用本地工具来完成多步骤任务。
```

看到 `[plugins] acme.hello@1.0.0: enabled` 就说明插件已扫描、导入、branded 校验、安装全部
通过；`[acme.hello] run started: ...` 是 `activate` 里的 hook 真的执行了。

## 在浏览器里跑同一个插件

同一个目录、同一份 `plugin.json` 与入口文件，浏览器宿主（`pnpm serve` 起的「浏览器 + 本机 Node
后端」那一态）也能装：应用启动时按当前会话的 workspace 扫描 `.webAgent/plugins/`
（[`apps/web/src/plugins/initialize.ts`](../apps/web/src/plugins/initialize.ts)），
不必先打开设置弹窗；面板（设置 → 插件）显示每个插件的状态、诊断，并逐个勾选它的模型可见工具。

浏览器与 CLI 只有「怎么求值入口」这一处不同，两条约束因此只对浏览器成立：

- **`@einfach-agent/core/plugin` 由宿主在求值前改写。** 浏览器走「经宿主命令桥读文件 → blob URL
  → 动态 import」（[`pluginImportModule.ts`](../apps/web/src/plugins/pluginImportModule.ts)），
  blob 模块没有 import map 可用来解析裸包名，所以宿主在求值前把这一个说明符改写成契约模块桥的
  URL（[`contractImportRewrite.ts`](../apps/web/src/plugins/contractImportRewrite.ts) 与
  [`contractModuleBridge.ts`](../apps/web/src/plugins/contractModuleBridge.ts)），插件拿到的是与应用
  **同一份** `definePlugin`。好处是浏览器上不依赖 pnpm 的 `node_modules` 链接；代价是：
  - 只桥 `@einfach-agent/core/plugin` 这一个说明符，其它裸包名（含 `@einfach-agent/react-plugin`）在
    浏览器上仍然解析失败；
  - 只认静态 `import ... from '@einfach-agent/core/plugin'`（含再导出）；写成
    `await import('@einfach-agent/core/plugin')` 会被直接拒绝并给出诊断。
- **入口必须是自包含的单文件 ESM。** blob URL 没有相对路径基准，入口里的 `import './other.js'`
  在浏览器上解析不到任何东西。CLI 侧的等价要求是「自带 Node 可直接消费的 ESM」。

## 发生了什么

- `-v` 下 `[plugins]` 每行对应
  [`apps/cli/src/plugins.ts`](../apps/cli/src/plugins.ts) 的 `reportCliPluginDiagnostics`：
  第一行是插件的终态（`enabled`/`incompatible`/`failed`），后续缩进行是该插件的诊断。
- `hello_from_plugin` 虽然注册成功（`grantedTools`/`withheldTools` 会分流），但被工具闸门拦
  下了——这不是 bug，是拍板的默认行为，见下面「当前边界」第 1 条。

## 当前边界

写这份文档时（P9 卡，浏览器部分随 P10/P11 更新，宿主口径随 T1 更新）的真实状态，不是设计意图：

1. **模型可见工具默认不可见，CLI 上没有任何打开它的入口。** 插件声明的模型可见工具默认
   全部不注册进模型清单（`origin: 'external'` 的工具一律按拍板 3 走闸门，见
   [`pluginToolGate.ts`](../packages/agent-core/src/plugins/pluginToolGate.ts)）。逐工具勾选只有
   浏览器的设置面板提供（P5/P6/P7 的 view-state 与 service 层已随 P10 挂进正在跑的应用）；
   CLI 不解析勾选配置，所以在 CLI 上 `withheldTools` 会一直非空。
2. **`entry.react` 今天不会生效。** 加载器只装 `entry.core`；如果插件只声明 `entry.react`、
   不声明 `entry.core`，会被标成 `incompatible`（诊断文案："未声明 core 入口，本加载器只装
   core 侧入口"）。React renderer 入口要等 React root 侧完成对应安装面（并把
   `@einfach-agent/react-plugin` 也加进浏览器的契约模块桥）之后才会生效。
3. **纯静态产物不支持用户插件。** 判据不是「是不是浏览器」而是**有没有登记宿主命令桥**：
   `static` 那一态没有桥，扫不到任何 workspace 文件，装配层据此整个跳过
   （`initialize.ts` 的 `host.kind !== 'server'` 早退），设置面板如实回答「当前宿主不支持用户插件」。
   配了本机 Node 后端的浏览器（`pnpm serve`）**是支持的**——[蓝图 3.4
   节](plugin-ecosystem-blueprint.md#34-宿主差异第一期不平均用力)当年按「浏览器没有文件系统」
   排除它，那个前提已随 Node 宿主线失效。
4. **在 CLI 上，插件目录必须放在本仓库工作区内。**
   `import { definePlugin } from '@einfach-agent/core/plugin'` 在 CLI 侧靠的是 pnpm workspace 在仓库根
   `node_modules/@einfach-agent/core` 建的符号链接——Node 的裸说明符解析沿插件文件所在目录向上找
   `node_modules`，只有插件目录落在仓库树内才能找到这条链接。浏览器宿主不受这条限制（宿主改写
   说明符，见上面「在浏览器里跑同一个插件」），但两个宿主都还没开放 npm 分发——它被
   [蓝图第 6 节](plugin-ecosystem-blueprint.md#6-分发) 的 G4（core 公开面收敛）阻塞，
   而分发本身也已被「不发布、仅本地跑」的裁决按下（见
   [Node 宿主树](node-host-issues.md) 的「分发口径」段）。
5. **装插件 = 完全信任。** 负责人 2026-08-20 拍板：外部插件与仓内插件**同权**，拿同一批 7 个
   loop hook 槽，因此一个插件可以否决任何一次工具调用（包括 shell 命令）、也可以改模型这一轮
   看到的上下文。宿主**不做**逐插件确认门（不像 MCP 起进程那样弹确认），因为插件入口本就是宿主
   `import()` 求值的同权代码——不经过任何 hook 也能直接 fetch、触达宿主命令桥，`plugin.json` 的
   `capabilities` 是申报不是沙箱。用户的控制点是「装不装」与设置面板的逐插件启停。裁决记录见
   [蓝图 4.3 节](plugin-ecosystem-blueprint.md#43-默认姿态--已拍板目录存在即信任)。

## 故障排查

- `[plugins] xxx: failed` 且诊断提到 "manifest 无效"：检查 `id` 是否是反向域名式
  （如 `acme.hello`）、`apiVersion` 是否恰好是 `1.0.0`。
- `[plugins] xxx: incompatible` 且诊断提到 "未声明 core 入口"：插件只写了 `entry.react`，
  CLI 只装 `entry.core`（当前边界第 2 条）。
- 完全没有任何 `[plugins]` 输出：确认加了 `-v`；`.webAgent/plugins/` 目录不存在时静默返回空
  结果，不算错误，也不会打印任何诊断。
- 报错 `Cannot find package '@einfach-agent/core'`（CLI）：插件目录不在本仓库工作区内（当前边界第 4 条）。
- 设置面板上诊断提到 "只能改写静态 import 语句"：入口用 `await import('@einfach-agent/core/plugin')`
  取契约模块了，改回顶层静态 `import ... from '@einfach-agent/core/plugin'`。
- 设置面板上诊断提到 `Failed to resolve module specifier`：入口 import 了浏览器宿主没有桥接的裸包名
  （只有 `@einfach-agent/core/plugin` 一个），或 import 了相对路径的第二个文件——入口必须自包含。
- CLI 报错缺 DeepSeek Key：先看是不是 shell 里残留了失效的 `DEEPSEEK_API_KEY`，按前置条件里
  的 `env -u` 用法屏蔽它。
