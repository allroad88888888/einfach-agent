# 010 DeepSeek 视觉适配器执行报告

## 改动摘要

- 新增 `deepseek-v4-flash-vision-exp` 常量、展示名与内置模型描述：1M context，沿用 DeepSeek
  Flash 的 Thinking effort/tool 能力，静态图片仅接受 JPEG/PNG/WebP。
- 新增 `DEEPSEEK_VISION_IMAGE_INPUT`，沿用现有产品边界：8 张、单文件 20 MiB、批次 40 MiB、
  4096×2160。
- 新增 `deepseekFiles.ts`：固定官方 `https://api.deepseek.com/files`，以 multipart `file` +
  `purpose=user_data` 并发上传，验证 `file-api-*` ID，保持选择顺序；部分失败、取消与显式 rollback
  都尽力删除已上传文件，且 cleanup 不继承已取消 signal。
- 新增 `deepseekMessages.ts`：仅视觉模型把 provider-neutral 图片块投影为
  `{ type: 'file', file_id }`，严格隔离 `deepseek:default` scope 与 `file-api-*`，不发送 `detail`；
  非视觉 DeepSeek 模型继续使用既有文本占位行为。
- 新增 `deepseekFileDisposal.ts`：从丢弃/保留内容计算远端引用差集，去重并 best-effort DELETE；
  忽略 Kimi `ms://`、错误 scope、外部 provider 与畸形 ID。
- 从原 359 行 `deepseek.test.ts` 按职责迁出 identity/catalog 测试；所有 `deepseek*.ts` 均不超过
  300 行。新增模块分别只负责上传批次、消息投影、文件清理。
- 在包 barrel 导出视觉适配器 API，并原地叠加用户未跟踪的模型目录/Thinking 测试内容，没有覆盖
  其余在途改动。

## 逐条验收命令与结果

1. `pnpm exec vitest run packages/agent-ai/src/deepseek*.test.ts`
   - 通过：7 个测试文件，36 项测试全部通过。
   - 覆盖模型目录、multipart 字段与固定 origin、顺序恢复、ID/MIME 校验、部分失败回滚、取消清理、
     幂等 rollback、消息 file block、无 `detail`、非视觉回归、引用隔离、保留引用保护与 best-effort
     删除。
2. `pnpm exec tsc -b packages/agent-ai/tsconfig.json`
   - 通过，无类型错误。
3. `wc -l packages/agent-ai/src/deepseek*.ts`
   - 通过；最大为 `deepseek.ts` 271 行，现有 `deepseek.test.ts` 280 行，其余均不超过 213 行。
4. `git diff --check -- packages/agent-ai`
   - 通过，无输出、无空白错误。

补充回归：

- `pnpm exec vitest run packages/agent-ai/src/deepseek*.test.ts packages/agent-ai/src/imageCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts`
  - 通过：9 个测试文件，72 项测试全部通过。
- `pnpm exec vitest run packages/agent-ai/src/*.test.ts`
  - 通过：33 个测试文件，268 项测试全部通过。

## 已完成覆盖矩阵行及证据

### C-001：模型目录与静态图片能力

- `deepseekCatalog.test.ts` 证明精确模型 ID、展示名、1M context、JPEG/PNG/WebP provider-upload
  能力及 High/Max Thinking 能力。
- `imageCapability.test.ts` 证明只有精确视觉模型获得图片能力，`deepseek-v4-pro` 仍不支持图片。
- `builtinThinkingCapabilities.test.ts` 证明视觉模型进入稳定目录顺序并沿用 DeepSeek Thinking 能力。

### C-002：Files API 上传、引用投影与清理

- `deepseekFiles.test.ts` 证明 `POST /files` multipart 的 `file`/`purpose=user_data`、Bearer、固定官方
  origin、并发结果排序、`file-api-*` 校验、部分失败/取消/显式 rollback 清理。
- `deepseekMessages.test.ts` 证明 Chat `{type:'file',file_id}` 投影、文本/图片顺序、不含 `detail`、
  provider/scope/ID 严格隔离及非视觉模型既有行为不回归。
- `deepseekFileDisposal.test.ts` 证明 discarded 去重、retained 差集保护、错误引用隔离和 DELETE
  best-effort 语义。

## 未验证项

- 未调用真实 DeepSeek 网络/API（任务禁止真实联网）；全部上游行为通过注入 fetch 验证。
- 未验证 Composer、host/browser 路由或 `view_image` 全链路；分别属于后续 020/040/050/060 叶子。
- 未运行全仓构建/state/boundaries 总门；本叶仅执行包级 TypeScript、agent-ai 全测试及规定 diff 门禁。

## 范围外发现

- 工作区在任务开始时已有 `builtinProviders.ts`、`index.ts`、`modelHttp.ts`、`providerRegistry.ts`、
  `providerTransport.ts` 等多处在途修改，以及未跟踪的模型/Thinking 文件；本任务只在允许文件内叠加，
  未 reset、checkout、暂存或提交。
- `builtinModelDescriptors.ts` 与 `builtinThinkingCapabilities.test.ts` 是用户在途未跟踪文件；仅加入
  DeepSeek 视觉目录行并保留其余内容。

## 疑虑

- 无本叶阻断项。真实上游响应与路由白名单仍依赖后续叶子和最终全链路验证。

## 建议后续动作

- 020 使用同一 `file-api-*` 校验规则开放固定官方 origin 的 POST/DELETE 路由。
- 040/050 直接消费 `prepareDeepSeekImageBatch`、`disposeDeepSeekProviderFiles` 与
  `DEEPSEEK_VISION_MODEL`，并确保失败、取消、丢弃路径调用 rollback/disposal。
- 080 重跑全仓 `tsc -b`、state/boundaries、相关构建与全链路测试。
