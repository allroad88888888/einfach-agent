# 040 执行报告：接通 DeepSeek Composer 图片会话

## 改动摘要

- 新增 `apps/web/src/modelInput/providerImageBatch.ts`，作为唯一的 Composer 图片批次分派器；它以精确 `provider:model` 映射选择 Kimi CN 或 `deepseek-v4-flash-vision-exp` adapter，保留 Kimi global 拒绝行为。
- `prepareProviderUserInput` 继续负责本地 Blob 与元数据校验，改为调用分派器；DeepSeek vision 会直接将 Composer 的原 Blob 交给 `prepareDeepSeekImageBatch`，不新增 detail 参数或 UI。
- `disposeProviderUserContent` 现在要求 Kimi 与 DeepSeek adapter 各自检查不透明的历史引用；DeepSeek 删除仍只接受 `deepseek`、`deepseek:default`、`file-api-*`，且 retained 内容会保护同一引用。
- `historyImageCompatibility` 改为按目标 provider 分派。DeepSeek 仅在精确 vision model、`deepseek` provider、`deepseek:default` scope 与有效 `file-api-*` 同时满足时恢复为可消费图片；Kimi 原有 CN/global 和 `ms://` 校验保持不变。
- 增加 Composer 上传/rollback、DeepSeek disposer、历史投影的覆盖；新建和改动的普通源/测试文件均低于 300 行。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/modelInput/prepareProviderUserInput.test.ts apps/web/src/modelInput/disposeProviderUserContent.test.ts apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.test.tsx apps/web/src/agentNew/ui/MessageTimelineRenderer.images.test.tsx packages/agent-ai/src/historyImageCompatibility.test.ts packages/agent-ai/src/deepseekFiles.test.ts packages/agent-ai/src/deepseekFileDisposal.test.ts`
   - 通过：7 个测试文件、28 项测试全部通过。
2. `pnpm exec vitest run apps/web/src/modelInput apps/web/src --testNamePattern='DeepSeek|Kimi|image|图片'`
   - 未全绿：55 通过、5 失败、898 跳过。失败均为并行在途的 `apps/web/src/agentNew/ui/SettingsCenter.test.tsx`：点击“打开设置”后找不到“模型”按钮；本叶未修改该文件。DeepSeek/Kimi/modelInput 相关测试通过。
3. `pnpm exec tsc -b apps/web/tsconfig.json`
   - 未执行到类型检查：仓库不存在该任务卡指定文件，TS5083。
   - 等价实际 Web 配置命令 `pnpm exec tsc -b tsconfig.app.json`：通过。
4. `git diff --check -- apps/web/src/modelInput apps/web/src/agent`
   - 通过，无空白错误。
   - 补充：`git diff --check -- packages/agent-ai/src/historyImageCompatibility.ts packages/agent-ai/src/historyImageCompatibility.test.ts` 也通过。
5. `wc -l`（本叶新增/大改文件）
   - 通过：最大 `prepareProviderUserInput.test.ts` 177 行；`providerImageBatch.ts` 78 行；所有相关文件低于 300 行。

## C-005 证据

- Composer 上传：`prepareProviderUserInput.test.ts` 验证 DeepSeek vision 使用 `POST https://api.deepseek.com/files`、`purpose=user_data`，且 multipart 文件保留 Composer 原始文件的名称、大小与 MIME；返回内容持久化为 `provider-file/deepseek/deepseek:default/file-api-*`，rollback 发送相应 DELETE。
- 历史恢复：`historyImageCompatibility.test.ts` 验证仅精确 vision model + 正确 provider/scope/file ID 可消费；错误模型、来源、scope 和 ID 一律投影为占位。现有 Kimi CN/global 及 `ms://` 测试仍通过。
- 丢弃清理：`disposeProviderUserContent.test.ts` 验证会话已切换到 Kimi 时仍由原 DeepSeek source owner 清理；retained 同引用和错误 scope 均不删除。`deepseekFileDisposal.test.ts` 同时覆盖 provider/scope/file-api 校验、去重与 retained 差集。

## 未验证项

- 未调用真实 DeepSeek 网络/API；任务约束要求使用注入 fetch。
- 未修改或人工验证 Composer detail UI；本叶没有 UI 改动，DeepSeek Composer 路径只上传原图。
- 任务卡的全量名称过滤测试未能因范围外 `SettingsCenter` 在途改动而全绿；最终整仓门禁应在并行 UI 改动稳定后重跑。

## 范围外发现

- `apps/web/src/agentNew` 存在大量用户/并行在途修改，所以上述过滤测试的 5 个 `SettingsCenter` 失败未修复。
- 任务卡列出的 `apps/web/src/agent/**` 目录不存在；实际唯一历史兼容 owner 是 `packages/agent-ai/src/historyImageCompatibility.ts`。经编排者确认，最小修改该 owner 与其测试后完成历史恢复闭环。
- 任务卡的 `apps/web/tsconfig.json` 不存在；实际 Web build 配置是根目录 `tsconfig.app.json`。

## 疑虑

- 无本叶产品行为阻断。全量过滤测试失败与指定 tsconfig 路径失效会影响总门的绿色展示，但均不由本叶代码引入。

## 后续建议

1. 在并行的 Settings Center 改动完成后重跑任务卡的名称过滤测试和最终 080 全仓门禁。
2. 编排层将 Web TypeScript 验收路径更新为 `tsconfig.app.json`，并把历史兼容 owner 写为 `packages/agent-ai/src/historyImageCompatibility.ts`。
