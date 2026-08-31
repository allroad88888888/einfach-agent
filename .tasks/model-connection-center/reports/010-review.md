# 010 R1 独立复审

## 结论

**APPROVED**。上一轮唯一 Important 已修复；更新后的三项验收均通过，未发现新的本轮范围内质量问题。

## 审查边界

- 仅复审上一轮 Important（静态 save 命令参数契约）及更新后的验收标准。
- 依据更新后的任务文件、执行报告、原任务文件范围的 `git diff c7befb48... -- <task files>`，以及对未跟踪 `connectionProfileCommandArgs.ts` 执行的等价 `git diff --no-index -- /dev/null ...`。
- 原任务文件范围的普通 diff 仍为空；本轮修复目标由指定的 `--no-index` 等价范围 diff 完整展示。
- 按指示未重跑报告已声明全绿的测试与 build。全仓 `tsc -b` 已由更新后的任务裁决移至 030/060 消费端迁移后的总门，不作为本轮失败。

## 上一轮 Important 复审

✅ **已修复：静态 save 命令参数契约已迁移。**

证据：`connectionProfileCommandArgs.ts` 的等价范围 diff 显示：

- 导入 `ConnectionProfileModel` 类型；
- `model_connection_profile_save.input` 声明为 `id`、`label`、`baseUrl`、`models: readonly ConnectionProfileModel[]` 与可选 `apiKey`；
- 不再包含旧 `model` 字段；
- `apiKey` 注释保持 write-only 与 omission preserves existing credential 语义。

该形状与任务要求的 `{ input: { id, label, baseUrl, models, apiKey? } }` 一致。文件共 18 行，职责单一，符合 `one-file-one-thing` 行数与职责规则。

## 验收标准逐条判定

### 1. Host validation / transaction / commands / forward 测试

✅ **通过（依据执行报告）**。

证据：报告记录指定 5 个测试文件、25 个测试全部通过，覆盖新旧记录、读取不主动写盘迁移、下一次成功 save 写新形状、模型校验与去重、原子保存与删除、同 URL profile 隔离及旧会话转发。

### 2. Web server host 测试

✅ **通过（依据执行报告）**。

证据：报告记录 `serverModelConnectionProfileHost.test.ts` 1 个测试通过；save payload 与公开响应使用多模型形状，响应序列化不含 write-only API Key。

### 3. Host build 与 diff check

✅ **通过（依据更新后的任务与执行报告）**。

证据：报告记录 R1 后复跑 `pnpm --filter @einfach-agent/host-node build` 通过，`git diff --check` 通过。更新后的验收 3 不再包含全仓 `tsc -b`。

## 质量发现

### Critical

无。

### Important

无。上一轮 Important 已关闭。

### Minor

无。

## 备注

- 全仓 `tsc -b` 未在本轮执行，符合更新后的任务裁决；030/060 的旧 `.model` 消费迁移不归因于 010，也不阻止本次批准。
- 本轮没有重新审查上一轮已接受、且不属于 R1 修复目标的实现细节。
