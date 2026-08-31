# 040 执行报告：仅支持 Kimi K3

状态：`DONE_WITH_CONCERNS`

## 改动摘要

- 将 Kimi 内置目录从 `kimi-k2.6` 切换为唯一模型 `kimi-k3`，新增并导出
  `KIMI_K3_MODEL = 'kimi-k3'`，`DEFAULT_KIMI_MODEL` 指向该常量；展示名为 `Kimi K3`；
  Kimi vendor fallback 与 K3 model context 均为 `1_000_000`。
- 将 Kimi Thinking capability 改为 `effort + required`：只允许
  `low | high | max`，`defaultEffort` 为 `max`，不能关闭。
- Kimi provider 投影只在精确命中 K3 capability 且 setting 合法时发送顶层
  `reasoning_effort`；Auto、脏值、历史值都省略 effort。无论会话残留 enabled/disabled/脏
  `thinking`，wire 都不发送该 K2.x 字段。
- Kimi 底层 call/stream 边界再次剥离 `thinking` 并校验 effort，避免绕过通用 adapter 的直接调用
  泄漏旧字段或脏值。
- 保留 CN/global endpoint、普通文本消息编码、流式 `include_usage` 行为；新增协议测试覆盖非流式
  CN 与流式 global。
- 子 Agent 两档均路由到最新的 `DEFAULT_KIMI_MODEL`，新增真实抽取请求断言，证明请求模型为
  `kimi-k3`、保留合法 effort 且不发送 `thinking`。
- 启动凭据目标夹具切换为 `kimi-k3`。`ModelCredentialPanel.tsx` 已通过
  `DEFAULT_KIMI_MODEL` 动态展示/创建会话，因此无需硬编码改动，默认常量切换后凭据表面自动使用 K3。
- 新增 `kimiK3Protocol.test.ts`，单一职责为验证 Kimi K3 请求协议；153 行。所有本叶新增/改动
  文件均不超过 300 行，最大为 `builtinProviders.ts` 290 行。
- 修复第 1 轮将先前误留的 131,072 vendor fallback 与 262,144 model context 统一修正为
  1,000,000，并在目录能力测试中分别钉住 vendor 与 exact model 两层数值。

## 逐条验收命令与结果

1. 专项协议、目录、routing、凭据测试：通过。

   ```sh
   pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/kimiK3Protocol.test.ts packages/subagents/src/defaultTierRouting.test.ts apps/web/src/settings/startupCredentialTarget.test.ts
   ```

   结果：5 个测试文件、60 项测试全部通过。

2. subagents 包专项回归：通过。

   ```sh
   pnpm exec vitest run packages/subagents/src
   ```

   结果：14 个测试文件、75 项测试全部通过。

3. TypeScript 工程类型检查：通过。

   ```sh
   pnpm exec tsc -b --pretty false
   ```

4. 状态不变量：通过。

   ```sh
   pnpm check:state
   ```

   结果：扫描 22 个 workspace、902 个非测试 TS/TSX 文件，5 条规则通过。

5. 包边界：通过。

   ```sh
   pnpm check:boundaries
   ```

   结果：扫描 918 个非测试 TS/TSX 文件，7 条规则通过；仅输出既有豁免观察项。

6. diff whitespace：通过。

   ```sh
   git diff --check
   ```

7. 本任务 files 范围内退役精确 ID/展示名扫描：通过，无命中。

   ```sh
   ! rg -n "kimi-k2\\.6|Kimi K2\\.6" packages/agent-ai/src/kimi.ts packages/agent-ai/src/kimiRegion.ts packages/agent-ai/src/builtinModelDescriptors.ts packages/agent-ai/src/builtinProviders.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/kimiK3Protocol.test.ts packages/subagents/src/defaultTierRoutingTable.ts packages/subagents/src/defaultTierRouting.test.ts apps/web/src/agentNew/ui/ModelCredentialPanel.tsx apps/web/src/settings/startupCredentialTarget.test.ts
   ```

8. 新测试文件尾随空白：通过，无命中。

   ```sh
   ! rg -n "[[:blank:]]+$" packages/agent-ai/src/kimiK3Protocol.test.ts
   ```

9. 文件行数门：通过。逐文件行数为 82、18、126、290、107、158、153、74、192、146、36，
   均不超过 300。

   ```sh
   wc -l packages/agent-ai/src/kimi.ts packages/agent-ai/src/kimiRegion.ts packages/agent-ai/src/builtinModelDescriptors.ts packages/agent-ai/src/builtinProviders.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/kimiK3Protocol.test.ts packages/subagents/src/defaultTierRoutingTable.ts packages/subagents/src/defaultTierRouting.test.ts apps/web/src/agentNew/ui/ModelCredentialPanel.tsx apps/web/src/settings/startupCredentialTarget.test.ts
   ```

10. 额外宽回归（非本叶 files 验收门）：未通过，结果已归类到范围外发现。

    ```sh
    pnpm exec vitest run packages/agent-ai/src
    ```

    结果：36 个测试文件中 28 通过、8 失败；269 项测试中 253 通过、16 失败。

## 已完成覆盖矩阵行及证据

| 矩阵行 | 完成内容 | 证据 |
| --- | --- | --- |
| C-01 | registry 精确包含六个目标模型，Kimi 仅 `kimi-k3`；vendor fallback 与 exact model context 均为 1M | `builtinThinkingCapabilities.test.ts` 的稳定目录精确相等与双层 context 断言；专项 60 tests 通过 |
| C-06 | K3 capability 为 required，档位仅 Low/High/Max，默认 Max | `builtinThinkingCapabilities.test.ts` capability 与 frozen efforts 断言 |
| C-07 | Auto 省略 effort；三档原样上行；脏值 fail closed；任何路径不发送 `thinking`；CN/global 与 stream/call 保留 | `kimiK3Protocol.test.ts`、`thinkingRequestProjection.test.ts` |
| C-10（当前 index） | Kimi tier routing 只产出 `kimi-k3`，抽取 wire 不发送 `thinking` | `defaultTierRouting.test.ts` 的表断言与真实 `runLowCostExtraction` fetch body 断言；subagents 75 tests 通过 |
| C-11 | profile/未知模型不冒充官方 Thinking 能力保持不回归 | `thinkingRequestProjection.test.ts` 的 OpenAI-compatible profile 与 execution fallback 断言 |

任务卡仍写“C-11 = routing”，但当前 `index.md` 已把 routing 定义为 C-10、C-11 定义为
profile/current fallback；本报告按当前 index 记录，并同时给出 C-11 的既有回归证据。

## 未验证项

- 未调用真实 Kimi 付费接口；按全局约束仅使用注入 fetch 的协议测试。
- 未执行全仓 `pnpm build`、Lingui extract/compile；它们属于任务树最终总门，不是 040 叶的列明验收。
- Kimi K3 图片上传、历史引用与清理未在本叶验证，明确属于 045。
- 未做 UI 浏览器截图/交互检查；凭据表面使用默认模型常量，启动凭据解析由专项测试覆盖。

## 范围外发现

- `pnpm exec vitest run packages/agent-ai/src` 有 16 个失败，均落在本任务 files 边界外的旧夹具：
  - Kimi 图片链路旧 K2.6 夹具：`kimiMessages.test.ts` 5 项、
    `providerRequestVendorDivergence.characterization.test.ts` 1 项、
    `historyImageCompatibility.test.ts` 3 项、`imageCapability.test.ts` 1 项；应由 045 续接 K3 图片
    协议与夹具。
  - 退役目录/协议夹具：`kimiChat.test.ts` 2 项、`modelThinkingCapability.test.ts` 2 项；应由
    055 清理旧模型引用，其中 Kimi chat 的“保留 thinking”断言已与 K3 官方协议冲突。
  - 030 已报告的旧 GLM 夹具：`builtinProviders.test.ts` 1 项、`vendorDescriptor.test.ts` 1 项；
    同属 055。`builtinProviders.test.ts` 在本叶开始前已是工作区修改文件，本叶未触碰。
- 工作区原有 `.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、CSS、
  `apps/desktop/gen/` 等无关改动均已保留，未暂存、覆盖或提交。

## 疑虑

- K3 descriptor 当前为保持既有图片能力仍复用名称为 `KIMI_K2_6_IMAGE_INPUT` 的 capability 常量；
  行为闭环需 045 按 K3 协议复核、重命名并更新图片链路测试。
- `builtinProviders.ts` 当前 290 行，虽然符合 300 行硬门，但后续继续加入非机械逻辑前应按职责拆分，
  避免越过上限。
- 宽回归目前不是全绿；必须完成依赖后续叶 045/055 后才能满足任务树总门。

## 建议后续动作

1. 按依赖顺序执行 045，更新 K3 图片 capability、消息编码/历史引用/清理及对应测试。
2. 执行 055，清理仓库内退役 `kimi-k2.6` 与旧 GLM 可执行夹具，再复跑 agent-ai 包测试。
3. 由独立 reviewer 审查 040，重点检查 required Thinking、直接调用防泄漏与 Kimi tier 抽取 wire。
4. 045/055 收口后复跑全仓类型、测试、Lingui、build 与最终静态扫描。
