# 020 独立审查报告

## 结论

**APPROVED**。四项验收标准均满足，C-02、C-03、C-09 均有实现与测试证据；指定范围内未发现 Critical、Important 或 Minor 质量问题。

## 审查范围与方法

- 仅依据任务文件 `020-deepseek-v4-efforts.md`、执行报告 `020-report.md`、指定 base `9d994a35128833c99897113755ceb8160e28b08f` 的范围 diff，以及未跟踪文件 `deepseekThinkingEffort.test.ts`。
- 遵照要求，没有重跑执行报告声称已通过的测试、TypeScript 构建或 `git diff --check`。
- 按 `one-file-one-thing` 规则检查了物理行数与职责：范围内最大文件为 `deepseek.ts` 271 行；`modelMigration.test.ts` 268 行；新增 `deepseekThinkingEffort.test.ts` 60 行。全部不超过普通文件 300 行上限，新增测试只负责 DeepSeek V4 effort 的 wire 投影。

## 验收标准逐条判定

### 1. enabled 时 low/high/max 原样上行；Auto/Off/medium/xhigh/未知值不由 adapter 原样上行

✅ **通过**。

证据：

- `packages/agent-ai/src/deepseek.ts:53-55` 将 wire 类型精确收口为 `'low' | 'high' | 'max'`。
- `packages/agent-ai/src/builtinProviders.ts:117-123` 仅在 Thinking 为 enabled 且 effort 属于 capability 声明的合法档位时投影 `reasoning_effort`；`:131-136` 的 DeepSeek adapter 再次只接受 low/high/max。
- `packages/agent-ai/src/deepseekThinkingEffort.test.ts:40-58` 编译期断言精确 union，实际注入 fetch 验证 low/high/max 原样发送，并验证 Auto、Off、medium、xhigh、未知值均不发送 effort。
- `packages/agent-ai/src/thinkingRequestProjection.test.ts:47-71` 同步覆盖通用请求投影路径的 DeepSeek low/high/max、Auto/Off、medium/xhigh/未知值。

### 2. 历史归一化保留 low，medium/xhigh 归 high，非法值删除；迁移测试证明幂等

✅ **通过**。

证据：

- `packages/agent-core/src/state/persistence/modelMigration.ts:18-27` 精确实现 low→low、medium→high、high→high、xhigh→high、max→max，其余值返回 `undefined`；`:30-43` 在 DeepSeek 设置袋迁移时移除非法 effort。
- `packages/agent-core/src/state/persistence/modelMigration.test.ts:32-45` 覆盖全部五个合法/历史输入及多类非法值。
- `packages/agent-core/src/state/persistence/modelMigration.test.ts:126-167` 验证旧平铺形状迁入设置袋、low 保留、medium/xhigh 收敛为 high、非法值删除，并以 `expect(migrateModelSettings(low)).toBe(low)` 证明 low 迁移结果二次迁移保持同一引用。

### 3. 三个 DeepSeek 模型顺序、1M context 与 Vision image capability 不变

✅ **通过**。

证据：

- 范围 diff 对 descriptor 只修改共享 Thinking capability；`packages/agent-ai/src/builtinModelDescriptors.ts:112-122` 仍按 Pro、Flash、Vision Exp 顺序声明三个模型，三者 context 均为 1,000,000，Vision 仍引用 `DEEPSEEK_IMAGE_INPUT`。
- `packages/agent-ai/src/builtinThinkingCapabilities.test.ts:49-60` 以固定 `EXPECTED_MODELS` 校验完整 catalog 顺序；`:62-77` 对三个 DeepSeek 模型逐一断言精确 efforts 与映射。
- `packages/agent-ai/src/deepseekCatalog.test.ts:13-28` 断言 Vision 的 1M context、`DEEPSEEK_VISION_IMAGE_INPUT`，以及 JPEG/PNG/WebP provider-upload capability。

### 4. DeepSeek 专项测试、TypeScript 构建与 diff check 通过

✅ **通过**（依据执行报告，按要求未重跑）。

证据：执行报告记录专项 Vitest 命令通过（6 files、118 tests）、`pnpm exec tsc -b --pretty false` 通过、`git diff --check` 通过且无输出。范围 diff 中的新增/更新断言与该命令列出的测试文件一致。

## 覆盖矩阵核对

| 行 | 判定 | 证据 |
| --- | --- | --- |
| C-02 | ✅ | 三个 DeepSeek descriptor 共享 `efforts: ['low', 'high', 'max']` 和完整映射；三模型参数化测试逐一校验，且没有设置 `required`（`builtinModelDescriptors.ts:60-65`，`builtinThinkingCapabilities.test.ts:62-77`）。 |
| C-03 | ✅ | adapter 只投影 enabled 的合法 effort；两组 fetch 注入测试覆盖 low/high/max 原样上行及 Auto/Off/medium/xhigh/未知值省略（`builtinProviders.ts:105-136`，`thinkingRequestProjection.test.ts:47-71`，`deepseekThinkingEffort.test.ts:25-58`）。 |
| C-09 | ✅ | Vision descriptor 保持 1M context 和图片输入常量；专项 catalog 测试继续断言 provider-upload 及 JPEG/PNG/WebP（`builtinModelDescriptors.ts:116-121`，`deepseekCatalog.test.ts:13-28`）。 |

## 质量发现

### Critical

无。

### Important

无。

### Minor

无。

## ⚠️ 无法核实

- 执行报告提到曾替换 `builtinProviders.test.ts` 的既有类型断言，但该文件不在本次指定 diff 范围和任务文件清单内，因此无法核实；按审查规则不计为 ❌。
- 执行报告列出的真实 DeepSeek 付费模型调用、最终总门和其它工作区改动均不属于本叶验收或指定 diff 范围，未核实，亦不计为 ❌。
