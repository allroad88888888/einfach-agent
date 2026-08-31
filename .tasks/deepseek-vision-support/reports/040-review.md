# 040 独立审查：DeepSeek Composer 图片会话

## 结论

**APPROVED**。范围 diff 内未发现 Critical 或 Important 缺陷；C-005 的上传、历史投影、清理差集与 rollback 链路均已接通，Kimi 的精确模型、feature gate 和 CN/global 区域行为未见回归。

本审查只依据任务卡、执行报告、指定 base 的范围 diff，以及未跟踪的 `providerImageBatch.ts` diff。按要求未重跑报告声称已执行的测试。

## 验收标准

1. ✅ 图片相关测试：报告中的等价精确命令通过 7 个文件、28 项测试，覆盖 Composer 上传、disposer、历史投影及 DeepSeek Files adapter。原任务卡的宽范围名称过滤命令出现 5 个失败，但均来自未纳入本叶 diff 的 `apps/web/src/agentNew/ui/SettingsCenter.test.tsx`；标记为范围外门禁噪声，不否定本叶精确测试结果。
2. ✅ Web TypeScript：任务卡指定的 `apps/web/tsconfig.json` 不存在，报告改用仓库实际配置 `pnpm exec tsc -b tsconfig.app.json` 并通过；等价类型门禁满足。
3. ✅ 空白检查：报告记录 `git diff --check -- apps/web/src/modelInput apps/web/src/agent` 通过，并补充检查了本叶纳入的两个 `historyImageCompatibility` 文件。

## C-005 核对

- ✅ **仅精确 DeepSeek vision model 上传**：`providerImageBatch.ts:62-77` 使用 `deepseek:${DEEPSEEK_VISION_MODEL}` 精确键分派，任何其他 DeepSeek 模型都会在进入 transport 前拒绝；`prepareProviderUserInput.ts:29-36` 仍先经过应用 capability gate。
- ✅ **Kimi 分派、feature gate、region 不回归**：Kimi 仍只接受 `DEFAULT_KIMI_MODEL`，`providerImageBatch.ts:37-48` 继续通过既有 region 解析并拒绝 global；`prepareProviderUserInput.ts:29-30` 保留公开 feature gate。现有 Kimi 精确测试在报告的 28 项测试中通过。
- ✅ **DeepSeek 历史投影**：`historyImageCompatibility.ts:64-80` 同时要求精确 vision model、`deepseek` provider、`DEEPSEEK_FILE_SCOPE` 和合法 `file-api-*` reference；失败均降级为不携带 provider reference 的 placeholder 元数据。Kimi projector 的模型、region/scope 和 `ms://` 约束保持原样。
- ✅ **discarded-retained 差集保护与清理归属**：`disposeProviderUserContent.ts:18-30` 把同一组 `discarded`、`retained` 同时交给 Kimi 和 DeepSeek owner 检查，不依赖会话当前设置。范围测试验证 retained 同引用不删除、错误 DeepSeek scope 不删除、会话切换至 Kimi 后仍能删除原 DeepSeek 文件；报告还记录 adapter 层的 provider/scope/reference 校验、去重和 retained 差集测试通过。
- ✅ **rollback**：`prepareProviderUserInput.ts:31-41` 原样暴露 adapter batch rollback；DeepSeek Composer 测试验证成功上传后的 rollback 对对应 `file-api-*` 发送 DELETE。上传中途失败的清理由任务卡声明消费的 `prepareDeepSeekImageBatch` owner 承担，报告列出的 `deepseekFiles.test.ts` 已通过；本叶没有绕过或改写该语义。
- ✅ **无 detail UI/伪字段**：本叶没有 UI 改动；`ProviderLocalImage` 与组装内容只传原始 Blob、名称、MIME、尺寸和图片元数据，没有 `detail` 或工具专用字段。
- ✅ **错误信息不泄漏 file ID/API key**：本叶新增错误只包含 vendor/model；本地数据校验只包含文件名。placeholder 也只返回显示元数据，不返回 provider reference。范围 diff 中没有把 API key 或 `file-api-*` 拼入错误文本的路径。

## 质量发现

### Critical

无。

### Important

无。

### Minor

- 测试证据粒度可更明确：范围内新增的 Composer 测试直接验证的是“成功上传后调用 rollback”，没有直接构造“多图上传中途失败后自动删除已上传文件”或“服务端失败错误脱敏”场景。执行报告列出的 adapter 测试通过，且这些语义由已消费的 010 adapter owner 负责，因此不作为本叶阻断项；后续报告宜明确指出对应测试用例名称。

## 范围外观察

- ⚠️ `apps/web/src/agentNew/ui/SettingsCenter.test.tsx` 的 5 个失败不在本叶指定 diff 内，需由对应并行改动或最终整仓门禁处理。
- ⚠️ 任务卡中的 `apps/web/tsconfig.json` 与 `apps/web/src/agent/**` 路径和实际仓库不一致；报告已分别使用 `tsconfig.app.json` 与 `packages/agent-ai/src/historyImageCompatibility.ts` 完成等价验证/实现，建议编排层修正文档路径。

## 文件职责与行数

新增 `providerImageBatch.ts` 只负责 provider/model 图片批次分派，职责单一，78 行；报告记录本叶新增/大改文件均低于 300 行，符合 one-file-one-thing 规则。
