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
M 模型 Provider   M1 注册契约与 registry   M2 core 凭据去枚举   M3 能力表并入注册
                  M4 边界门禁加厂商名红线   M5 OpenAI-compatible 第四家（试金石）
                  M6 子 agent 档位路由外移
P 插件生态        P1 蓝图   （P2+ 实现卡待蓝图评审后拆）
未决              插件生态蓝图评审（P1 产出后由用户过目再放行实现卡）
```

并行规则：M1 与 P1 改动面不重叠可先行；M2/M3 依赖 M1；M4 依赖 M2（豁免清单要等
M2 收敛）；M5 依赖 M1+M2；M6 依赖 M1+M2。

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
- **状态**：DOING

### M2 · core 凭据去厂商枚举

- **依赖**：M1
- **改动面**：`packages/agent-core/src/runtime/core/runtimeConfig.ts`
  （三个 key 字段 → `modelCredentials: Record<string, string>`）、
  `runtime/commands/runCommands.ts`（switch → 查表）、`configureCommands` 调用方
  （`apps/web/src/main.tsx`、`apps/cli/src/runtime.ts`、测试 setup）
- **判据**：`grep -rn 'deepseekApiKey\|glmApiKey\|kimiApiKey' packages/agent-core/src`
  仅剩兼容 shim 或为零；两宿主装配同步改；相关 vitest + `pnpm build` 通过
- **模型**：opus
- **状态**：TODO

### M3 · vendorDescriptor 并入注册动作

- **依赖**：M1
- **改动面**：`packages/agent-ai/src/vendorDescriptor.ts`、`providerRegistry.ts`
- **判据**：厂商能力描述随 adapter 注册一并提供，`vendorDescriptorFor` 等公开查询函数
  签名不变、改由 registry 支撑；新增厂商不再需要单独改能力表文件；相关 vitest + build
- **模型**：sonnet
- **状态**：TODO

### M4 · check-boundaries 增加 core 厂商名红线

- **依赖**：M2
- **改动面**：`scripts/check-boundaries.js`、`scripts/check-boundaries.test.js`
- **判据**：新规则扫描 `packages/agent-core/src` 中的厂商名字面量
  （deepseek/glm/kimi/moonshot/zhipu/openai/anthropic/gemini），非豁免文件命中即 fail；
  豁免清单显式列出并打印为观察项：`state/persistence/modelMigration.ts`（历史迁移）、
  `subagents/modelSelection.ts` 与 `childModelClient.ts`（待 M6 迁出）；测试覆盖命中与豁免
- **模型**：sonnet
- **状态**：TODO

### M5 · OpenAI-compatible 第四家 adapter（试金石）

- **依赖**：M1、M2
- **改动面**：`packages/agent-ai/src/openaiCompat.ts`（新建，含测试）、registry 注册、
  装配层凭据接线；**`packages/agent-core` 必须零 diff**
- **判据**：自定义 base_url 的 OpenAI-compatible 端点可作为 vendor 使用（离线协议测试，
  不要求真实 Key）；验收命令含 `git diff --stat packages/agent-core/` 为空；同时消掉
  `docs/launch/comparison.md` 弱项 3 里"无 OpenAI-compatible 兜底"一句（同卡更新文档）
- **模型**：opus
- **状态**：TODO

### M6 · 子 agent 档位路由外移

- **依赖**：M1、M2
- **改动面**：`packages/agent-core/src/subagents/modelSelection.ts` 的厂商模型名外移到
  装配层（`packages/subagents` 或宿主注入的路由配置），core 保留抽象档位语义
- **判据**：core 内不再出现 deepseek 模型名字面量；子 agent 路由行为不回归
  （`pnpm exec vitest run packages/agent-core/src/subagents`）；M4 豁免清单相应缩短
- **模型**：opus
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
- **状态**：DOING

## 未决（不编号、不排期）

- **插件生态蓝图评审**：P1 产出后由用户过目拍板，再拆 P2+ 实现卡。动态加载第三方代码
  的信任模型（确认粒度、默认关还是默认开）必须用户点头，不替用户决定。
