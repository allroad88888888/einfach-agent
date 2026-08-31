# 040 — 连接来源预设报告

## 改动摘要

- 新增 `apps/web/src/settings/modelConnectionPresetRegistry.ts`：提供 OpenRouter、硅基流动、火山方舟、vLLM、SGLang、Ollama OpenAI compatibility、LM Studio 的只读 OpenAI-compatible 预设。
- 预设按稳定应用 key 排列；每次集合读取或单项查询都创建新的 preset 与 model 对象，防止调用方修改内部 registry。
- 所有预置模型均标记为 `source: 'manual'`；自托管 vLLM/SGLang 的地址留空；未加入官方 DeepSeek、GLM、Kimi。
- 新增对应 Vitest，覆盖类别与协议、地址校验、自托管空地址、稳定顺序、查找与深层防御性副本。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionPresetRegistry.test.ts`
   - 通过：1 个测试文件、3 个测试全部通过。
2. `pnpm exec tsc -p tsconfig.app.json --noEmit`
   - 未通过（范围外中间态）：无本任务文件报错。现有下游仍引用旧的单一 `model` 字段、若干 mock 未实现新 `probe`，且 host `NodeHostCommandArgs` 尚未加入 `model_connection_profile_probe`。详见“范围外发现”。
3. `git diff --check`
   - 通过：无输出。
4. `git diff --no-index --check /dev/null apps/web/src/settings/modelConnectionPresetRegistry.ts` 及测试文件
   - 无格式错误输出；该命令因比较新增文件与 `/dev/null` 返回 1（表示存在 diff），不是检查失败。
5. `wc -l apps/web/src/settings/modelConnectionPresetRegistry.ts apps/web/src/settings/modelConnectionPresetRegistry.test.ts`
   - 通过：分别为 101 行、56 行，均低于 300 行上限。

## 未验证项

- 未联网验证各文档 URL 或示例模型在提供商当前仍可用：任务要求不进行真实上游网络访问，且模型仅为示例，不宣称已发现或可用。
- 无法在当前共享 worktree 验证全仓 `tsc` 通过，需待 020/030/060 等下游迁移完成后由总门复验。

## 范围外发现

- `apps/web/src/agentNew/ui/ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx`、`apps/web/src/settings/defaultModelConnectionRuntime.ts`、`modelConnectionProfileCommands*`、`modelConnectionProfileState.ts`、`settingsCenterCommands.test.ts` 仍使用旧 `profile.model` 形状。
- 多个 `ModelConnectionProfileHost` mock 未实现新 `probe` 方法。
- `packages/host-node/src/commandArgs.ts` 的 `NodeHostCommandArgs` 尚未声明 `model_connection_profile_probe`。
- 上述均未改动，超出本任务 files 边界。

## 疑虑

- 本任务的全仓类型检查验收被并行叶的契约迁移中间态阻塞；registry 自身已在复跑中不再出现在 TypeScript 错误列表。

## 建议后续动作

- 由 030/060 迁移 UI 与 settings 侧旧 `model` 消费，并由 020 补齐 probe 命令参数面；随后执行 070 总门的完整类型检查。
