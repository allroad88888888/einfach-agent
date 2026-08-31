# 010 DeepSeek 视觉适配器独立审查

## 结论

**APPROVED**。指定范围内未发现 Critical、Important 或 Minor 级问题；C-001、C-002 与四条验收标准均有实现或执行报告证据支撑。

## 审查范围与方法

- 仅阅读任务文件 `010-deepseek-vision-adapter.md`、执行报告 `010-report.md`，以及任务指定的 14 个产品/测试文件相对基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 的 diff。
- 对 7 个未跟踪文件分别以 `git diff --no-index /dev/null <file>` 检查；对已跟踪文件使用指定的基线 diff。
- 按要求没有重跑执行报告声称已运行的 Vitest/TypeScript 测试。行数仅作静态规则复核。
- `builtinModelDescriptors.ts` 是任务说明标注的用户在途未跟踪文件；no-index diff 无法区分原有内容和本任务增量，因此只判断与本任务相关的 DeepSeek 视觉目录行，不评价其余在途内容。

## 验收标准逐条判定

### 1. DeepSeek 测试命令

✅ **通过**。

- 执行报告记录 `pnpm exec vitest run packages/agent-ai/src/deepseek*.test.ts` 通过，7 个文件、36 项测试全部成功；遵照审查要求未重跑。
- 范围内测试与实现相互印证：multipart、固定官方 origin、并发后恢复选择顺序见 `deepseekFiles.test.ts:17-60`；显式 rollback、部分失败回滚、取消清理见 `deepseekFiles.test.ts:62-139`；无效 ID/MIME/origin 覆盖见 `deepseekFiles.test.ts:141-171`。
- 真实请求投影、无 `detail`、非视觉回归及错误 provider/scope/ID 隔离见 `deepseekMessages.test.ts:22-101`；丢弃去重、保留保护、错误引用忽略及 best-effort 删除见 `deepseekFileDisposal.test.ts:19-66`。

### 2. agent-ai TypeScript 构建

✅ **通过**。

- 执行报告记录 `pnpm exec tsc -b packages/agent-ai/tsconfig.json` 无类型错误；遵照要求未重跑。
- 新增公开 API 已从包边界导出：`index.ts:8-13` 导出目录、DeepSeek 常量、上传、消息投影与清理模块。

### 3. 文件行数与单一职责

✅ **通过**。

- 静态复核 `wc -l`：`deepseek.ts` 271、`deepseekFiles.ts` 160、`deepseekMessages.ts` 66、`deepseekFileDisposal.ts` 55、`deepseek.test.ts` 280、三个新增测试分别为 172/102/67 行，均不超过普通文件 300 行上限。
- 职责边界成立：`deepseekFiles.ts` 只处理上传批次与回滚，`deepseekMessages.ts` 只处理 wire message 投影，`deepseekFileDisposal.ts` 只处理丢弃引用删除；未见按行数机械切割或大杂烩文件。

### 4. diff 空白检查

✅ **通过**。

- 执行报告记录 `git diff --check -- packages/agent-ai` 无输出；遵照要求未重复执行该门禁。
- 审阅指定 diff 未发现肉眼可见的空白错误。

## 覆盖矩阵

### C-001：模型目录与静态图片能力

✅ **通过**。

- 精确模型常量为 `deepseek-v4-flash-vision-exp`，并有对应展示名：`deepseek.ts:21-42`。
- 图片能力只声明 JPEG/PNG/WebP，并给出 8 张、20 MiB/张、40 MiB/批、4096×2160 边界：`imageCapability.ts:34-44`。
- 模型目录项声明 1,000,000 token context、上述图片能力，并复用与 V4 Pro/Flash 相同的 `DEEPSEEK_THINKING` 对象：`builtinModelDescriptors.ts:60-65,112-121`。
- DeepSeek vendor 的工具上限为 128，视觉模型通过同一 vendor descriptor 继承：`builtinModelDescriptors.ts:105-120`；内置 DeepSeek adapter 实际使用该 descriptor：`builtinProviders.ts:221-226`。
- Thinking 请求投影按精确 vendor/model 查询能力，仅允许 capability 支持的 effort，DeepSeek 最终只上行 `high|max`：`builtinProviders.ts:95-139`。

### C-002：Files API 上传、引用投影与清理

✅ **通过**。

- 官方 Files origin 固定来自 `https://api.deepseek.com`，上传 URL 构造为 `/files`，未暴露可覆盖 origin：`deepseek.ts:21-25`、`deepseekFiles.ts:65-70`。
- 上传为 `POST` multipart，字段精确为 `file` 与 `purpose=user_data`，只手工设置 Bearer、不伪造 multipart `Content-Type`：`deepseekFiles.ts:73-95`；对应断言见 `deepseekFiles.test.ts:17-47`。
- 返回 ID 使用集中校验器，必须匹配安全的 `file-api-*` 形态；上传块保存为 provider-neutral `provider-file`，provider/scope 分别固定为 `deepseek`/`deepseek:default`：`deepseekMessages.ts:26-28`、`deepseekFiles.ts:97-122`。
- 只有精确视觉模型进入 file-aware projector；其他 DeepSeek 模型继续走原有 `nonVisualMessages` 占位逻辑，流式与非流式调用共享同一 prepare 路径：`deepseek.ts:119-155,184-218`。
- wire file block 只有 `{ type: 'file', file_id }`；代码中没有伪 `detail` 字段，同时严格拒绝非 provider-file、外部 provider、错误 scope、Kimi `ms://` 和畸形 ID：`deepseekMessages.ts:15-18,30-49`。
- 批量上传通过 `Promise.allSettled` 保持输入顺序；任何部分失败或取消都会删除已成功上传项，cleanup 不继承已取消 signal；显式 rollback best-effort 且幂等：`deepseekFiles.ts:125-159`。
- 丢弃清理只收集正确 provider/scope/ID，先去重再减去 retained 集合，最后对官方 DELETE URL 执行 best-effort `Promise.allSettled`：`deepseekFileDisposal.ts:13-55`。

## 质量发现

### Critical

无。

### Important

无。

### Minor

无。

## 范围限制

- ⚠️ 执行报告引用的 `deepseekCatalog.test.ts`、`imageCapability.test.ts` 与 `builtinThinkingCapabilities.test.ts` 不在本次 reviewer 明确给出的 diff 文件列表内，无法独立检查其源码断言；这不计为 ❌。相关产品实现本身已在指定范围内核实。
- ⚠️ 真实 DeepSeek API、Composer/host/browser 路由和后续叶子集成不在本任务范围内，无法核实；这不计为 ❌。
