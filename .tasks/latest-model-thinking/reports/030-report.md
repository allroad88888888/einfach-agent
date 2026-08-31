# 030 执行报告：仅支持 GLM-5.3 系列

状态：`DONE_WITH_CONCERNS`

## 改动摘要

- 将 GLM 官方模型常量收口为 `GLM_PRO_MODEL = 'glm-5.3'` 与
  `GLM_FLASH_MODEL = 'glm-5.3-flash'`，`DEFAULT_GLM_MODEL` 指向 Pro。
- GLM catalog 精确只保留两个 5.3 SKU：均为 1M context、文本输入（图片未审计/不支持）、
  Thinking `required: true`，手动档位仅 `low | high | max`，官方默认档位记为 `max`。
- 将 `GlmReasoningEffort` 收窄为 `low | high | max`。GLM adapter 在请求边界将缺失、
  `disabled`、非法对象或布尔 `false` 全部强制投影为 `thinking:{type:'enabled'}`；非法/
  历史 effort 不上行，Auto 通过省略 `reasoning_effort` 表达。
- 强制 `thinking` wire 仅在 GLM adapter 内生效，未把厂商无关的 `required` 能力误解为所有
  厂商都必须发送 `thinking` 字段，为后续 Kimi K3“必须思考但不发该字段”保留正确协议边界。
- 子 Agent Pro/Flash routing 分别改为两个新常量，生产 routing 不再产出旧 GLM ID。
- 新增 `glm53Protocol.test.ts`，专责覆盖两个 GLM-5.3 SKU 的强制 Thinking、三档 effort、
  脏值 fail-closed 和 Auto 省略语义。

## 逐条验收命令与结果

1. 专项测试

   ```sh
   pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/glm53Protocol.test.ts packages/subagents/src/defaultTierRouting.test.ts
   ```

   结果：通过，4 个测试文件、45/45 tests passed。

2. 类型检查

   ```sh
   pnpm exec tsc -b --pretty false
   ```

   结果：通过，无诊断。

3. 状态不变量

   ```sh
   pnpm check:state
   ```

   结果：通过，扫描 22 个 workspace `src/` 下 902 个非测试 TS/TSX 文件，5 条规则生效。

4. 边界检查

   ```sh
   pnpm check:boundaries
   ```

   结果：通过，扫描 918 个非测试 TS/TSX 文件，7 条规则生效；输出的观察项均为
   已有豁免，无本任务新增边界问题。

5. diff 检查

   ```sh
   git diff --check
   ```

   结果：通过，无空白错误。

6. 文件行数检查

   ```sh
   wc -l packages/agent-ai/src/glm.ts packages/agent-ai/src/builtinModelDescriptors.ts packages/agent-ai/src/builtinProviders.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/thinkingRequestProjection.test.ts packages/agent-ai/src/glm53Protocol.test.ts packages/subagents/src/defaultTierRoutingTable.ts packages/subagents/src/defaultTierRouting.test.ts
   ```

   结果：通过，分别为 61 / 131 / 267 / 98 / 158 / 76 / 76 / 154 行，全部低于 300 行。

7. 生产 GLM 旧 ID 扫描

   ```sh
   rg -n "glm-(5\\.2|5\\.1|5-turbo|4\\.7|4\\.6|4\\.5|4-long|4-flash)" packages/agent-ai/src/glm.ts packages/agent-ai/src/builtinModelDescriptors.ts packages/agent-ai/src/builtinProviders.ts packages/subagents/src/defaultTierRoutingTable.ts
   ```

   结果：通过，无命中；任务生产边界不再声明或路由到旧 GLM ID。

## 已完成覆盖矩阵行及证据

- `C-01`（本叶 GLM 切片完成）：`builtinThinkingCapabilities.test.ts` 验证 GLM registry 精确只有
  `glm-5.3` / `glm-5.3-flash`，显示名、1M context 与图片不支持声明均正确。全局“六个最新
  模型”尚待 040 将 Kimi K2.6 替换为 K3，以及 055 做最终夹具收口。
- `C-04`：同一能力测试验证两个 GLM 均为 `required: true`，仅暴露 `low/high/max`，
  `defaultEffort: max`；专项 wire 测试证明不能被脏会话状态关闭。
- `C-05`：`glm53Protocol.test.ts` 对两个 SKU 均验证强制 `thinking:{type:'enabled'}`，
  wire 仅接受 `low/high/max`，历史/非法 effort 省略，Auto 省略 effort。
- `C-11`（任务 030 列明行）：`thinkingRequestProjection.test.ts` 仍通过，自定义
  OpenAI-compatible profile 与未知 vendor fallback 不获得官方 Thinking 字段。
- 补充：index 当前将“子 Agent routing 只产出最新 ID”编号为 `C-10`，而 030 任务文件将
  routing 描述放在 `C-11`。GLM 的 `C-10` 切片已由 `defaultTierRouting.test.ts` 验证：Pro/Flash
  分别为两个 5.3 ID，旧 `glm-5-turbo` 为表外模型，且低价抽取的脏 `thinking:false`
  在 GLM wire 边界恢复为 enabled。

## 未验证项

- 未调用真实 GLM 付费 API；按全局约束仅使用注入 fetch 的协议测试。
- 未执行 `pnpm build`、Lingui extract/compile 或 UI/视觉审计；这些属于 index 最终总门，
  030 验收标准只要求 GLM/subagents 专项测试、类型、边界与 diff 检查。

## 范围外发现

执行额外包级回归：

```sh
pnpm exec vitest run packages/agent-ai/src packages/subagents/src
```

结果：49 个测试文件中 46 通过、3 失败；331 tests 中 327 通过、4 失败。四个失败均是
任务 `files` 边界外的旧 GLM 夹具断言：

- `packages/agent-ai/src/builtinProviders.test.ts`：仍用 `glm-5.2` 期待 `max` effort。该文件为
  298 行存量文件，index 明确禁止继续塞测试。
- `packages/agent-ai/src/modelThinkingCapability.test.ts`：两条断言仍以旧 GLM unsupported/toggle 模型与
  `xhigh` 档位为夹具。
- `packages/agent-ai/src/vendorDescriptor.test.ts`：仍以已退役 `glm-4.5-flash` 作精确模型上下文
  断言；现在该 ID 正确落到 GLM vendor 的 1M 保守 fallback。

未修改上述文件：它们不在 030 `files` 边界内，且任务树已将“清理退役模型的可执行引用”
交给 055。工作区原有 `.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar/CSS、
`builtinProviders.test.ts` 与 `apps/desktop/gen/` 等无关改动均未触碰。

## 疑虑

- 030 任务内验收闭合，但包级回归在 055 清理退役夹具前会保持上述 4 个已知失败，
  因此本次状态为 `DONE_WITH_CONCERNS` 而非无条件 `DONE`。
- index 与 030 任务文件对子 Agent routing 的矩阵编号存在 `C-10` / `C-11` 不一致；
  实现与测试覆盖面无缺口，但建议编排者在账本中统一编号。

## 建议后续动作

1. 独立 reviewer 审查 030，并由编排者复跑 4 个专项文件。
2. 按依赖顺序执行 040/045，确保 Kimi K3 利用 `required` 能力但在其 adapter 中不发
   `thinking` 字段。
3. 在 055 中更新上述三个范围外旧夹具文件，然后复跑 agent-ai/subagents 包级回归。
4. 最终 060 再执行 index 中的 build、Lingui、全仓退役 ID 扫描与六模型总门。
