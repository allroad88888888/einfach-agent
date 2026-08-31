# 010 独立审查

## 结论

**APPROVE**

未发现阻塞或非阻塞缺陷。实现满足 010 叶的能力契约、官方裁决、精确查询、只读枚举、拆分职责与行数要求；共享 worktree 中既有的 openai-compat connection profile/transport 改动未被本叶的 descriptor 抽取回归。

## 严重度

- Critical：无。
- High：无。
- Medium：无。
- Low：无。

## 审查证据

### 逐模型 Thinking 能力

- `packages/agent-ai/src/builtinModelDescriptors.ts:58-62`：DeepSeek V4 Pro/Flash 共用的正向档位严格为稳定顺序 `high, max`；`low/medium/xhigh` 只存在于兼容映射元数据，不进入可选档位。
- `packages/agent-ai/src/builtinModelDescriptors.ts:64-69`：GLM-5.2 正向档位严格为 `low, medium, high, xhigh, max`；`minimal, none` 单独进入 `disabledAliases`，没有混入正向档位。
- `packages/agent-ai/src/builtinModelDescriptors.ts:111-126`：GLM-5.1/5/5-Turbo、4.7 系列、4.6、4.5-Air/AirX/Flash 均为 toggle-only；GLM-4-Long 与两项 4-Flash-250414 均为 unsupported，边界与 index 表逐项一致。
- `packages/agent-ai/src/builtinModelDescriptors.ts:127-134`：Kimi K2.6 为 toggle-only，不含 `efforts` 或 `defaultEffort`，没有伪造固定 effort。
- `packages/agent-ai/src/modelThinkingCapability.ts:3-37`：判别联合明确区分 `unsupported | toggle | effort | unknown`，wire effort union 不含 `auto`；`modelSupportsThinking` 只把 toggle/effort 判为支持。
- `packages/agent-ai/src/modelThinkingCapability.ts:65-87`：非 effort 能力返回空档位；合法 effort 与 disabled alias 分开验证，能让后续 UI/adapter 独立 fail closed。

### 精确查询、枚举与不可变性

- `packages/agent-ai/src/providerRegistry.ts:123-146`：执行 `resolve` 保留历史 fallback；能力 `describeModel` 直接查已注册 adapter，没有调用 `resolve`，因此未知 vendor/model 不继承 DeepSeek 执行 fallback。
- `packages/agent-ai/src/modelThinkingCapability.ts:52-59`：精确查询缺失 descriptor 或 thinking 时统一返回冻结的 `UNKNOWN_THINKING_CAPABILITY`。`openai-compat` descriptor 的 models 为空，因此自定义兼容模型保持 unknown。
- `packages/agent-ai/src/providerRegistry.ts:134-146`：枚举按 registry 的 vendor 注册顺序与 descriptor 的模型声明顺序生成，重复调用顺序稳定；返回数组及每个枚举项均被冻结。
- `packages/agent-ai/src/builtinModelDescriptors.ts:24-55,99-106`：内置 descriptor 的 image capability、effort 数组、映射、disabled aliases、model、models 表及 vendor descriptor 均被冻结；枚举引用到的内置嵌套能力同样不可变。
- `packages/agent-ai/src/builtinThinkingCapabilities.test.ts:5-102`：17 个内置模型的完整顺序、展示名、四类能力、DeepSeek/GLM/Kimi 特例和运行时冻结均有明确断言。

### 拆分与共享在途改动

- 相对基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 的 tracked diff 显示，模型 descriptor 数据从 `builtinProviders.ts` 移入 `builtinModelDescriptors.ts`；`builtinProviders.ts` 当前只保留 adapter 装配及其请求投影。
- `builtinProviders.ts` 中 `providerLocalTransport`、`connectionId`、`connectionBaseUrl`、legacy origin 等 connection profile/transport 逻辑属于共享 worktree 的既有在途增量；010 仅把四个 adapter 的 descriptor 来源替换为 `builtinVendorDescriptor(...)`。现有 endpoint/identity 分支保持不变并通过回归测试。
- 根出口同时导出新 catalog/capability；其中 `providerLocalTransport` 出口属于既有在途改动，未作为 010 增量误判。

### 验证结果

- `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/providerRegistry.test.ts`：3 files / 30 tests passed。
- `pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts packages/agent-ai/src/vendorDescriptor.test.ts packages/agent-ai/src/imageCapability.test.ts`：3 files / 20 tests passed，覆盖 descriptor 拆分后的既有 provider、connection endpoint、vendor/image 查询回归。
- `pnpm --filter @einfach-agent/ai build`：通过。
- `git diff --check`：通过；四个未跟踪新增源码/测试文件另以 `git diff --no-index --check` 检查，无 whitespace error。
- `wc -l`：`modelThinkingCapability.ts` 87、`builtinModelDescriptors.ts` 142、`providerRegistry.ts` 149、`builtinProviders.ts` 180、两份新增测试 62/102、`index.ts` 30；全部不超过 300 行。

## 范围确认

审查覆盖 index、010 叶、`reports/010-report.md`、叶声明文件的 tracked/untracked diff，并按基线区分共享 worktree 既有改动。审查未修改产品代码、任务文件，未暂存或提交。
