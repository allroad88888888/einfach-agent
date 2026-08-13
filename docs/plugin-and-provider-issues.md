# 插件生态与模型 Provider 注册化 Issue 树

目标：两条线补齐"装配式内核"的最后两块短板。
M 线——模型厂商从"五处硬编码"变成"只加 adapter + 装配层注册一行"，对齐
einfach-agent-rust 的红线 12（core 零厂商判断），试金石是新增第四家 provider 时
`packages/agent-core` 零 diff。
P 线——把已有的 assembly-time 插件机制产品化成 pi 式的"用户插件"：可从目录动态加载、
可启停、有信任确认。

约定：每卡 20 分钟左右（含验收）；conventional commit 每卡一枚；改 TS 跑相关 vitest +
`pnpm build`，改 `.md` 跑 `node scripts/check-docs.js`。

## 树

```text
M 模型 Provider   M1 registry ✔   M2 凭据去枚举   M3 能力表并入注册   M4 厂商名红线门禁
                  M5a openaiCompat 协议实现   M5b 注册与装配接线   M5c 试金石验收
                  M6a 档位路由契约   M6b 装配层路由实现   M7 deepseekUserId 去专名化   M8 routeReason 中立化   M9 settings 联合开放化   M10 红线正则收紧
P 插件生态        P1 蓝图 ✔   P2 manifest 契约   P3 目录扫描器   P4 动态加载与安装
                  P5 设置面板   P6 工具勾选闸门   P7 熔断与归因   P8 CLI 接线   P9 样例与上手验收   P10 桌面接线   P11 桌面模块解析
```

并行规则：改动面不重叠且依赖满足即可并行。M2/M3 依赖 M1；M4 依赖 M2；
M5a 依赖 M1，M5b 依赖 M5a+M2，M5c 依赖 M5b；M6a 依赖 M1+M2，M6b 依赖 M6a。
P2 不依赖 M 线；P3 依赖 P2；P4 依赖 P3；P5/P6/P7 依赖 P4；P8 依赖 P4；P9 依赖 P5+P6。
2026-08-13 按"每卡 20 分钟"重拆过一轮：M5/M6 各拆为协议/接线/验收层次，P 线按
蓝图第 3–6 节拆为八张。

## 现状事实（写卡依据，已核实）

- `packages/agent-ai/src/modelAdapter.ts`：`ModelAdapterSettings` 是闭合 union，
  `callModel/streamModel` 里 if 链按 vendor 分发。
- `packages/agent-core/src/runtime/core/runtimeConfig.ts`：`deepseekApiKey/glmApiKey/kimiApiKey`
  三个厂商字段；`runtime/commands/runCommands.ts` 有按 vendor 取 key 的 switch。
- `packages/agent-ai/src/vendorDescriptor.ts`：厂商能力表；core 传不透明字符串查询，
  本身可留在 agent-ai，但新增厂商要单独改它（应并入注册动作）。
- `packages/agent-core/src/subagents/modelSelection.ts`：子 agent Pro/Flash 档位路由
  写死 deepseek 模型名，在 core 里。
- Rust 参照：`Provider` trait 四纯函数、装配层显式 match 合法、core 零厂商名由
  invariants 脚本强制、凭据经不透明 profile id。

## M · 模型 Provider 注册化

### M1 · agent-ai 内建 provider registry 与注册契约

- **依赖**：—
- **改动面**：`packages/agent-ai/src/providerRegistry.ts`（新建）、`modelAdapter.ts`
  （改为经 registry 路由）、`index.ts`（导出）；colocated 测试
- **判据**：定义 `ProviderAdapter` 契约（call / stream / descriptor / 特化 settings
  归一）；deepseek/glm/kimi 三家改为注册进 registry；`callModel/streamModel` 公开签名
  不变、行为经 registry 分发；未知 vendor 走现有 fallback 行为不回归；
  `pnpm exec vitest run packages/agent-ai` 全绿 + `pnpm build`
- **模型**：opus
- **状态**：DONE 52fef15

### M2 · core 凭据去厂商枚举

- **依赖**：M1
- **改动面**：`packages/agent-core/src/runtime/core/runtimeConfig.ts`
  （三个 key 字段 → `modelCredentials: Record<string, string>`）、
  `runtime/commands/runCommands.ts`（switch → 查表）、`configureCommands` 调用方
  （`apps/web/src/main.tsx`、`apps/cli/src/runtime.ts`、测试 setup）
- **判据**：`grep -rn 'deepseekApiKey\|glmApiKey\|kimiApiKey' packages/agent-core/src`
  仅剩兼容 shim 或为零；两宿主装配同步改；相关 vitest + `pnpm build` 通过
- **模型**：opus
- **状态**：DONE 603b5e4

### M3 · vendorDescriptor 并入注册动作

- **依赖**：M1
- **改动面**：`packages/agent-ai/src/vendorDescriptor.ts`、`providerRegistry.ts`
- **判据**：厂商能力描述随 adapter 注册一并提供，`vendorDescriptorFor` 等公开查询函数
  签名不变、改由 registry 支撑；新增厂商不再需要单独改能力表文件；相关 vitest + build
- **模型**：sonnet
- **状态**：DONE 5b3eb42

### M4 · check-boundaries 增加 core 厂商名红线

- **依赖**：M2
- **改动面**：`scripts/check-boundaries.js`、`scripts/check-boundaries.test.js`
- **判据**：新规则扫描 `packages/agent-core/src` 中的厂商名字面量
  （deepseek/glm/kimi/moonshot/zhipu/openai/anthropic/gemini），非豁免文件命中即 fail；
  豁免清单显式列出并打印为观察项：`state/persistence/modelMigration.ts`（历史迁移）、
  `subagents/modelSelection.ts` 与 `childModelClient.ts`（待 M6 迁出）；测试覆盖命中与豁免
- **模型**：sonnet
- **状态**：DONE 0ca9c94（豁免 15 项含观察项 37 处；M6b/M7 落地后收缩）

### M5a · openaiCompat adapter 协议实现

- **依赖**：M1
- **改动面**：`packages/agent-ai/src/openaiCompat.ts`（新建）+ colocated 测试
- **判据**：标准 OpenAI-compatible chat/completions 的 call/stream 实现，`baseUrl` 必填、
  无厂商私有净化；离线协议测试覆盖请求形状与流式；`pnpm exec vitest run packages/agent-ai`
- **模型**：opus
- **状态**：DONE 89f8cf8

### M5b · openaiCompat 注册与装配接线

- **依赖**：M5a、M2
- **改动面**：`packages/agent-ai/src/builtinProviders.ts`（注册 + descriptor）、
  两宿主装配层的凭据/baseUrl 配置通路
- **判据**：`openai-compat` 作为 vendor 可被 resolve；凭据经 M2 的 `modelCredentials`
  不透明表接入；相关 vitest + `pnpm build`
- **模型**：sonnet
- **状态**：DONE 9129d29（web 侧凭据面板受 Rust 枚举限制暂不接，见卡内说明）

### M5c · 试金石验收与文档更新

- **依赖**：M5b、M9
- **改动面**：`docs/launch/comparison.md`（弱项 3 措辞）、`docs/model-adapter-compatibility.md`
  （新 vendor 准入记录）
- **判据**：`git log` 证明 M5a/M5b 两卡的提交对 `packages/agent-core` 零 diff
  （`git diff <M1后基线>..HEAD --stat -- packages/agent-core/` 为空）；文档同步；check-docs
- **模型**：sonnet
- **状态**：DONE 90ae7a4

### M6a · 子 agent 档位路由契约化

- **依赖**：M1、M2
- **改动面**：`packages/agent-core/src/subagents/modelSelection.ts`（deepseek 模型名字面量
  抽成可注入的档位路由表接口，core 保留 Pro/Flash 抽象语义与默认注入点）
- **判据**：core 内不再出现厂商模型名字面量；`pnpm exec vitest run
  packages/agent-core/src/subagents` 不回归
- **模型**：opus
- **状态**：DONE 28bcc51

### M6b · 装配层提供默认档位路由

- **依赖**：M6a
- **改动面**：`packages/subagents` 或宿主装配（默认路由表落点按 M6a 契约定）、
  M4 豁免清单同步缩短
- **判据**：两宿主行为与拆分前一致；`scripts/check-boundaries.js` 的豁免清单移除
  `modelSelection.ts`；相关 vitest + build
- **模型**：sonnet
- **状态**：DONE 5ecad37（两条过期豁免待 M9 落地后统一收缩）

### M7 · deepseekUserId 去专名化

- **依赖**：M2
- **改动面**：`packages/agent-core/src/runtime/core/runtimeConfig.ts` 的 `deepseekUserId`、
  `runtime/delegationContract.ts`、`runtime/core/delegateModelIdentity.ts` 及 `subagents/`
  相关引用——收敛为不透明的 per-vendor 附加配置或改名为中立语义
- **判据**：core 内该字段不再带厂商专名；相关 vitest + `pnpm build`；M4 豁免清单相应缩短
- **模型**：opus
- **状态**：DONE d4953fb（豁免清单 6→1，仅剩 modelMigration.ts）

### M8 · SubagentRouteReason 去厂商字样

- **依赖**：M6b
- **改动面**：`packages/agent-core/src/subagents/types.ts` 的 `SubagentRouteReason` 两个含
  deepseek 字样的取值及其消费方；归档/回放兼容评估（`routeReason` 是持久化稳定标识）
- **判据**：新取值中立化；老归档读回不炸（回放脚本对含旧值的 fixture 跑通）；相关 vitest
- **模型**：opus
- **状态**：DONE 8822f86

### M9 · ModelVendor/ModelSettings 闭合联合开放化

- **依赖**：M2；**阻塞 M5c**（M4 审计发现：`state/core.type.ts` 的按厂商判别联合是 core
  厂商名的总根源，新增 vendor 必然改 core，零 diff 判据在此之前不成立）
- **改动面**：`packages/agent-core/src/state/core.type.ts` 的 `ModelVendor`/`ModelSettings`、
  `runtime/modelSettingsProjection.ts`、`runtime/contextDistillation.ts`、
  `runtime/commands/sessionCommands.ts` 及相关 fixtures——把"闭合 union + 按 vendor 收窄"
  改为"不透明 vendor id + 供应商附加设置袋（bag）"，厂商特化字段的解释权移交 agent-ai adapter
- **判据**：core 内 `settings.vendor === '<具体厂商>'` 分支归零；M4 豁免清单去掉对应 9 项；
  会话持久化兼容（老会话设置读回不炸）；`pnpm exec vitest run packages/agent-core` + build
- **模型**：opus
- **状态**：DONE e1b9e4f（观察项 38→16；门禁逃逸修复与豁免收缩见 8224c53）

### M10 · 红线正则收紧（snake_case 逃逸修复）

- **依赖**：M7（同文件在途）
- **改动面**：`scripts/check-boundaries.js` 的 `vendorNamePattern`（`\\b` → 前后
  `[A-Za-z0-9]` 环视）、`scripts/check-boundaries.test.js` 补 snake_case 用例、
  `packages/agent-core/src/observability/redact.ts` 的 `OPENAI_STYLE_KEY` 常量改中立名
- **判据**：M8 侦察已实测 fallout 仅 redact.ts 一处；收紧后
  `node scripts/check-boundaries.js` 通过；`pnpm exec vitest run scripts packages/agent-core/src/observability` 全绿
- **模型**：sonnet
- **状态**：DONE f624114

## P · 插件生态

### P1 · 插件生态蓝图

- **依赖**：—
- **改动面**：`docs/plugin-ecosystem-blueprint.md`（新建）、`docs/README.md` 索引行
- **判据**：`node scripts/check-docs.js` 通过；蓝图覆盖——现状盘点（assembly-time 插件
  已有的 hook/渲染/受限命令面）、动态加载面（`.webAgent/plugins/` 扫描、错误隔离、
  信任确认借鉴 MCP stdio 先例）、启停与设置页、npm 包作为插件源（依赖发包蓝图）、
  与 R5 持久化 RFC 的关系、安全模型与非目标；明确标注为蓝图
- **模型**：opus
- **状态**：DONE eb66682

### P2 · manifest 契约与解析器

- **依赖**：—
- **改动面**：`packages/agent-core/src/plugins/manifest.ts`（新建，纯逻辑）+ 测试
- **判据**：`plugin.json` 解析与校验（id 复用 R5 正则与禁用前缀、apiVersion 区间匹配、
  capabilities 枚举、entry 分 core/react）；坏输入全部归为结构化诊断不抛异常；vitest + build
- **模型**：opus
- **状态**：DONE 75edc37

### P3 · 插件目录扫描器

- **依赖**：P2
- **改动面**：`tools/skills` 的扫描先例为参照，新建插件扫描（落点按 P2 契约层次定，
  Node bridge 复用 CLI 现有文件桥）
- **判据**：扫 `.webAgent/plugins/`，目录不存在不算错误；单条失败记 diagnostics 不影响
  其余；上限保护；vitest
- **模型**：sonnet
- **状态**：DONE 599d357

### P4 · 动态加载与安装接线

- **依赖**：P3
- **改动面**：加载器（import → branded 校验 → install/disposer）+ 与 plugin host 的接线
- **判据**：目录即信任直接加载（拍板 1）；加载失败标 failed/incompatible 不阻塞启动；
  top-level 副作用注册的插件拒绝；启停走 disposer 无残留；vitest + build
- **模型**：opus
- **状态**：DONE accb9f1

### P5 · 插件设置面板

- **依赖**：P4
- **改动面**：`apps/web/src/agentNew/ui/` 新增插件面板（列表、状态机、启停）
- **判据**：discovered/enabled/disabled/failed/incompatible 状态可见可切换；启停状态
  按用户持久化（拍板 4）；组件测试
- **模型**：sonnet
- **状态**：DONE 3a86d9d

### P6 · 模型可见工具勾选闸门

- **依赖**：P4
- **改动面**：插件工具注册路径 + 面板逐工具勾选 + 按用户存储
- **判据**：插件声明的模型可见工具默认不进清单；勾选后进入；记录按用户存不随
  workspace（拍板 3/4）；vitest 覆盖默认关与勾选开
- **模型**：opus
- **状态**：DONE 7cac552

### P7 · 熔断与 trace 归因

- **依赖**：P4
- **改动面**：plugin host 失败计数 + 自动停用；插件相关 span/event 补 `plugin.id`/`plugin.version`
- **判据**：连续 3 次失败自动停用、需手动恢复（拍板 5）；trace 可按插件归因；vitest
- **模型**：sonnet
- **状态**：DONE 928e253

### P8 · CLI 宿主接线

- **依赖**：P4
- **改动面**：`apps/cli/src/runtime.ts` 装配加载器（core 侧入口，外部插件须自带 Node 可用 ESM）
- **判据**：CLI 能加载目录插件并在 `-v` 下打出插件诊断；`pnpm cli` 冒烟
- **模型**：sonnet
- **状态**：DONE 6d5803b

### P9 · 样例外部插件与 20 分钟上手验收

- **依赖**：P5、P6
- **改动面**：仓库外形态的样例插件（fixture 目录）+ `docs/plugin-ecosystem-blueprint.md`
  的"已交付"标注更新 + 上手文档
- **判据**：按上手文档从零写一个插件（hook + renderer + 一个勾选后可见的工具）可在
  20 分钟内跑通（蓝图的成败标准）；check-docs
- **模型**：sonnet
- **状态**：DONE cfe72f0（真实 CLI 运行验证，4 步零卡点）


### P10 · 桌面宿主接线

- **依赖**：P4、P5
- **改动面**：桌面/Web 装配层——Tauri 读文件 bridge 复用 + `importModule` 的 blob 求值实现 +
  启动时扫描加载接线（`apps/web/src/main.tsx` 或独立装配模块）；Rust 侧若需新 command 单列
- **判据**：桌面端能扫描并加载 `.webAgent/plugins/` 下的插件；浏览器预览宿主明示不支持
  （蓝图 3.4）；相关 vitest + build
- **模型**：opus
- **状态**：DONE 8f94611（CSP 现状不挡 blob；模块解析缺口拆为 P11）

### P11 · 桌面插件模块解析（裸说明符与品牌同一性）

- **依赖**：P10
- **改动面**（已定）：两条互不依赖的措施同时落地——
  1. 品牌改全局注册表 Symbol：`pluginContracts.ts` 的 `publicPluginBrand` 与
     `agent-react/src/reactPlugin.ts` 的 `reactPluginBrand` 改 `Symbol.for`（品牌是"防裸对象
     误装"的判据不是安全边界，插件本就与应用同权，换来跨模块实例可识别）；
  2. 求值前改写说明符：新增 `apps/web/src/plugins/contractModuleBridge.ts`（把宿主自己的
     `@web-agent/core/plugin` 实例做成 blob 模块 URL，经 `globalThis` 交接）与
     `contractImportRewrite.ts`（只改静态 `import/export ... from '<说明符>'` 里的说明符
     token，动态 `import()`/`import.meta.resolve()` 拒绝并给诊断），`desktopImportModule.ts`
     在造 blob 前接这一步。未选 import map：打包后的页面没有可指的 URL，仍要先有桥
- **判据**：quickstart 式插件（裸说明符 import）在桌面 webview 能 enabled；CLI 路径不回归
  （`pnpm exec vitest run apps/cli`）；`packages/agent-core` 的品牌契约测试同步；
  `pnpm exec vitest run apps/web/src/plugins packages/agent-core/src/plugins` 全绿
- **模型**：opus
- **状态**：DONE e1574ae

## 未决（已拍板，2026-08-13）

插件生态蓝图评审已完成，六项决策：
1. **信任姿态**：目录存在即信任（插件的 hook/renderer 面免确认加载）。
2. **首期宿主**：桌面 + CLI；浏览器预览明示不支持。
3. **模型可见工具**：默认不可见，需在插件面板逐工具勾选启用——这是唯一硬闸门。
4. **勾选/启停记录按用户存**（不随 workspace/Git 走），`.webAgent/plugins/` 允许进 Git。
5. **熔断**：连续 3 次失败自动停用，手动恢复。
6. **npm 分发**：等 core 公开面收敛（G4），首期仅本地目录。
P2+ 实现卡按此拆解排期。
