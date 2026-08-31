# 030 独立审查：仅支持 GLM-5.3 系列

结论：**APPROVED**。

## 审查范围

本审查只依据任务文件 `030-glm-5-3-family.md`、执行报告 `030-report.md`、指定基线
`e146e46e147c2cdc9790b4f51a62355a1c4184df` 到限定文件的范围 diff，以及新增未跟踪测试
`glm53Protocol.test.ts`。按要求不重跑执行报告已声明通过的测试或检查。

## 验收标准逐条判定

1. ✅ **GLM registry 精确只有 5.3 与 5.3-Flash，均 required、三档、1M context。**
   - `builtinModelDescriptors.ts` 的 GLM vendor descriptor 删除全部旧 SKU，只登记
     `glm-5.3` 与 `glm-5.3-flash`。
   - 两个 SKU 共用 `GLM_5_3_THINKING`：`required: true`，`efforts` 精确为
     `low/high/max`，`defaultEffort: max`；模型 context 均为 1,000,000。
   - `builtinThinkingCapabilities.test.ts` 同时断言 GLM registry 的精确 key 集合、两个模型
     的 1M context、图片输入 unsupported、required、三档与默认 max。

2. ✅ **任意脏 `thinking:false` 在请求边界投影为 enabled；wire 只允许 low/high/max。**
   - `builtinProviders.ts` 的 `glmRequest()` 对 required 模型无条件覆盖输出
     `thinking: { type: 'enabled' }`，不会沿用会话中的 disabled/非法值。
   - 同一函数只会重新加入 `low`、`high`、`max` 三种 `reasoning_effort`；其他值被省略。
   - 新增 `glm53Protocol.test.ts` 对两个 SKU 都覆盖缺失 thinking、disabled 对象、非法对象、
     布尔 `false`，并逐一覆盖三种合法 effort、五种历史/非法 effort，以及 Auto 省略 effort。

3. ✅ **子 Agent Pro/Flash 分别路由到两个新 ID，生产 routing 不再产出旧 ID。**
   - `glm.ts` 导出 `GLM_PRO_MODEL = 'glm-5.3'`、
     `GLM_FLASH_MODEL = 'glm-5.3-flash'`，且默认模型指向 Pro。
   - `defaultTierRoutingTable.ts` 使用上述默认 Pro 与导入的 Flash 常量，删除本地旧
     `glm-5-turbo` 常量。
   - `defaultTierRouting.test.ts` 断言 GLM 表精确路由到新 Pro/Flash SKU、旧
     `glm-5-turbo` 为表外模型，并验证 Flash 委派的实际 wire 恢复 required Thinking。
   - 执行报告给出的限定生产文件旧 ID 扫描无命中；范围 diff 也未见生产 routing 继续产出旧 ID。

4. ✅ **专项测试、类型检查、边界检查、diff check 通过。**
   - 执行报告记录四个专项测试文件共 45/45 tests passed。
   - 执行报告记录 `tsc -b`、`check:state`、`check:boundaries`、`git diff --check` 全部通过。
   - 报告记录八个范围文件均少于 300 行，符合本仓库文件行数硬规则。
   - 额外包级回归的 4 个失败均被报告定位为范围外旧 GLM 夹具断言，并已归属后续 055。
     从给定 diff 与失败说明看，它们要求的是已退役 ID/能力，未揭示本叶产品行为缺陷，故不作为
     030 拒绝理由。

## 覆盖矩阵本叶核对

- ✅ **C-01（GLM 目录切片）**：registry 精确收口到两个 GLM-5.3 SKU；能力测试验证名称、
  1M context 与图片 unsupported 声明。
- ✅ **C-04（强制思考能力）**：两个 descriptor 都是 required，且仅 low/high/max、默认 max；
  能力测试同时调用 `modelRequiresThinking()` 验证 required 语义。
- ✅ **C-05（GLM wire）**：`glmRequest()` 强制 enabled 并过滤 effort；新增协议测试对两个 SKU、
  脏 thinking、合法/非法 effort 与 Auto 语义形成直接覆盖。
- ✅ **C-10（子 Agent routing）**：生产 tier 表只使用新 Pro/Flash 常量；路由测试覆盖精确映射、
  旧 ID 表外行为及 Flash 委派请求体。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. `030-report.md` 的覆盖矩阵叙述存在编号笔误：它称“任务 030 将 routing 描述放在 C-11”，
   但本次给定的任务文件明确列出并要求核对的是 C-10。该笔误不影响实现或测试；实际 C-10 证据完整。

## 最终判断

四条验收标准及 C-01、C-04、C-05、C-10 的本叶覆盖均满足。没有 Critical 或 Important
质量发现，范围外旧夹具失败也未暴露本叶产品缺陷，因此批准 030。
