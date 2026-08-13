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
                  M6a 档位路由契约   M6b 装配层路由实现
P 插件生态        P1 蓝图 ✔   P2 manifest 契约   P3 目录扫描器   P4 动态加载与安装
                  P5 设置面板   P6 工具勾选闸门   P7 熔断与归因   P8 CLI 接线   P9 样例与上手验收
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
- **状态**：DOING

### M3 · vendorDescriptor 并入注册动作

- **依赖**：M1
- **改动面**：`packages/agent-ai/src/vendorDescriptor.ts`、`providerRegistry.ts`
- **判据**：厂商能力描述随 adapter 注册一并提供，`vendorDescriptorFor` 等公开查询函数
  签名不变、改由 registry 支撑；新增厂商不再需要单独改能力表文件；相关 vitest + build
- **模型**：sonnet
- **状态**：DOING

### M4 · check-boundaries 增加 core 厂商名红线

- **依赖**：M2
- **改动面**：`scripts/check-boundaries.js`、`scripts/check-boundaries.test.js`
- **判据**：新规则扫描 `packages/agent-core/src` 中的厂商名字面量
  （deepseek/glm/kimi/moonshot/zhipu/openai/anthropic/gemini），非豁免文件命中即 fail；
  豁免清单显式列出并打印为观察项：`state/persistence/modelMigration.ts`（历史迁移）、
  `subagents/modelSelection.ts` 与 `childModelClient.ts`（待 M6 迁出）；测试覆盖命中与豁免
- **模型**：sonnet
- **状态**：TODO

### M5a · openaiCompat adapter 协议实现

- **依赖**：M1
- **改动面**：`packages/agent-ai/src/openaiCompat.ts`（新建）+ colocated 测试
- **判据**：标准 OpenAI-compatible chat/completions 的 call/stream 实现，`baseUrl` 必填、
  无厂商私有净化；离线协议测试覆盖请求形状与流式；`pnpm exec vitest run packages/agent-ai`
- **模型**：opus
- **状态**：TODO

### M5b · openaiCompat 注册与装配接线

- **依赖**：M5a、M2
- **改动面**：`packages/agent-ai/src/builtinProviders.ts`（注册 + descriptor）、
  两宿主装配层的凭据/baseUrl 配置通路
- **判据**：`openai-compat` 作为 vendor 可被 resolve；凭据经 M2 的 `modelCredentials`
  不透明表接入；相关 vitest + `pnpm build`
- **模型**：sonnet
- **状态**：TODO

### M5c · 试金石验收与文档更新

- **依赖**：M5b
- **改动面**：`docs/launch/comparison.md`（弱项 3 措辞）、`docs/model-adapter-compatibility.md`
  （新 vendor 准入记录）
- **判据**：`git log` 证明 M5a/M5b 两卡的提交对 `packages/agent-core` 零 diff
  （`git diff <M1后基线>..HEAD --stat -- packages/agent-core/` 为空）；文档同步；check-docs
- **模型**：sonnet
- **状态**：TODO

### M6a · 子 agent 档位路由契约化

- **依赖**：M1、M2
- **改动面**：`packages/agent-core/src/subagents/modelSelection.ts`（deepseek 模型名字面量
  抽成可注入的档位路由表接口，core 保留 Pro/Flash 抽象语义与默认注入点）
- **判据**：core 内不再出现厂商模型名字面量；`pnpm exec vitest run
  packages/agent-core/src/subagents` 不回归
- **模型**：opus
- **状态**：TODO

### M6b · 装配层提供默认档位路由

- **依赖**：M6a
- **改动面**：`packages/subagents` 或宿主装配（默认路由表落点按 M6a 契约定）、
  M4 豁免清单同步缩短
- **判据**：两宿主行为与拆分前一致；`scripts/check-boundaries.js` 的豁免清单移除
  `modelSelection.ts`；相关 vitest + build
- **模型**：sonnet
- **状态**：TODO

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
- **状态**：TODO

### P3 · 插件目录扫描器

- **依赖**：P2
- **改动面**：`tools/skills` 的扫描先例为参照，新建插件扫描（落点按 P2 契约层次定，
  Node bridge 复用 CLI 现有文件桥）
- **判据**：扫 `.webAgent/plugins/`，目录不存在不算错误；单条失败记 diagnostics 不影响
  其余；上限保护；vitest
- **模型**：sonnet
- **状态**：TODO

### P4 · 动态加载与安装接线

- **依赖**：P3
- **改动面**：加载器（import → branded 校验 → install/disposer）+ 与 plugin host 的接线
- **判据**：目录即信任直接加载（拍板 1）；加载失败标 failed/incompatible 不阻塞启动；
  top-level 副作用注册的插件拒绝；启停走 disposer 无残留；vitest + build
- **模型**：opus
- **状态**：TODO

### P5 · 插件设置面板

- **依赖**：P4
- **改动面**：`apps/web/src/agentNew/ui/` 新增插件面板（列表、状态机、启停）
- **判据**：discovered/enabled/disabled/failed/incompatible 状态可见可切换；启停状态
  按用户持久化（拍板 4）；组件测试
- **模型**：sonnet
- **状态**：TODO

### P6 · 模型可见工具勾选闸门

- **依赖**：P4
- **改动面**：插件工具注册路径 + 面板逐工具勾选 + 按用户存储
- **判据**：插件声明的模型可见工具默认不进清单；勾选后进入；记录按用户存不随
  workspace（拍板 3/4）；vitest 覆盖默认关与勾选开
- **模型**：opus
- **状态**：TODO

### P7 · 熔断与 trace 归因

- **依赖**：P4
- **改动面**：plugin host 失败计数 + 自动停用；插件相关 span/event 补 `plugin.id`/`plugin.version`
- **判据**：连续 3 次失败自动停用、需手动恢复（拍板 5）；trace 可按插件归因；vitest
- **模型**：sonnet
- **状态**：TODO

### P8 · CLI 宿主接线

- **依赖**：P4
- **改动面**：`apps/cli/src/runtime.ts` 装配加载器（core 侧入口，外部插件须自带 Node 可用 ESM）
- **判据**：CLI 能加载目录插件并在 `-v` 下打出插件诊断；`pnpm cli` 冒烟
- **模型**：sonnet
- **状态**：TODO

### P9 · 样例外部插件与 20 分钟上手验收

- **依赖**：P5、P6
- **改动面**：仓库外形态的样例插件（fixture 目录）+ `docs/plugin-ecosystem-blueprint.md`
  的"已交付"标注更新 + 上手文档
- **判据**：按上手文档从零写一个插件（hook + renderer + 一个勾选后可见的工具）可在
  20 分钟内跑通（蓝图的成败标准）；check-docs
- **模型**：sonnet
- **状态**：TODO


## 未决（已拍板，2026-08-13）

插件生态蓝图评审已完成，六项决策：
1. **信任姿态**：目录存在即信任（插件的 hook/renderer 面免确认加载）。
2. **首期宿主**：桌面 + CLI；浏览器预览明示不支持。
3. **模型可见工具**：默认不可见，需在插件面板逐工具勾选启用——这是唯一硬闸门。
4. **勾选/启停记录按用户存**（不随 workspace/Git 走），`.webAgent/plugins/` 允许进 Git。
5. **熔断**：连续 3 次失败自动停用，手动恢复。
6. **npm 分发**：等 core 公开面收敛（G4），首期仅本地目录。
P2+ 实现卡按此拆解排期。
