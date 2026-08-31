# 030 执行报告：管理连接模型草稿

## 改动摘要

- 将连接草稿从单一 `model` 改为 `models: readonly ConnectionProfileModel[]`，编辑既有 profile 时完整复制模型草稿。
- 增加 `modelConnectionProfileProbeStateAtom` 及 probe 成功、加载、错误状态；probe 仅接收当前草稿的 `baseUrl` 与临时 API Key，结果不会覆盖已选模型。
- 新增手动添加、删除、替换草稿模型命令；保存要求至少一个模型；保存、取消、删除与设置关闭后仍清空密码草稿。
- 默认运行时仅在持久化的 `(connectionId, model)` 仍属于 profile 的 `models` 时映射；缺失模型安全回退且不改偏好。
- OpenAI-compatible transport registry 明确投影为 `{ id, kind, baseUrl }`，丢弃任何附带模型或 Key 字段。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/defaultModelConnectionCommands.test.ts apps/web/src/modelTransport/connectionProfileTransport.test.ts`
   - 通过：3 个测试文件、15 个测试全部通过。覆盖 probe 成败、手动模型增删/替换、至少一个模型才可保存、密码清理、transport 不含模型/Key、默认缺失模型安全回退。
2. `pnpm check:state`
   - 通过：状态不变量检查通过。
3. `git diff --check`
   - 通过：无输出，未发现空白错误。
4. `wc -l <任务 files>`
   - 通过：所有本次源文件及测试文件均不超过 300 行；最大为 `modelConnectionProfileState.ts` 的 199 行。

## 未验证项

- 未运行 `pnpm exec tsc -b`：任务说明明确将全仓类型总门留给 060，届时 UI 消费方才会从旧单模型契约迁移。
- 未进行真实上游联网探测；测试只使用注入 host 模拟。

## 范围外发现

- 无产品代码范围外改动。

## 疑虑

- 任务 files 在当前 worktree 都显示为未跟踪，因此普通 `git diff <base>` 不会呈现这些文件的内容；已使用定向测试与 `git diff --check` 验证。审查时需按 index 记录的未跟踪文件审查方式生成等价 diff。

## 建议后续动作

- 060 应迁移 UI 的草稿模型编辑与 probe 结果选择，并执行全仓 `pnpm exec tsc -b`；070 再复核 Key、transport 投影与删除模型后的默认安全回退。

## 修复第 1 轮

### 改动摘要

- 新增共享的 `hasModelIds()` 判定：模型数组必须非空，且每个模型的 `id.trim()` 非空。
- `modelConnectionProfileValidAtom` 与 `saveInput()` 均使用该判定；空白模型 ID 既不会显示为有效，也不会调用 host save。
- 增加回归断言，覆盖 `{ id: '   ', label: 'Blank', source: 'manual' }`。

### 验收命令与结果

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/settings/defaultModelConnectionCommands.test.ts apps/web/src/modelTransport/connectionProfileTransport.test.ts`
   - 通过：3 个测试文件、15 个测试全部通过；新回归断言确认空白模型 ID 被拒绝且未触发 save。
2. `pnpm check:state`
   - 通过：状态不变量检查通过。
3. `git diff --check`
   - 通过：无输出，未发现空白错误。
4. `wc -l apps/web/src/settings/modelConnectionProfileState.ts apps/web/src/settings/modelConnectionProfileCommands.ts apps/web/src/settings/modelConnectionProfileCommands.test.ts`
   - 通过：分别为 203、196、157 行，均不超过 300 行。

### 未验证项

- 仍未运行留给 060 的 `pnpm exec tsc -b`，亦未进行真实上游联网探测。

### 范围外发现、疑虑与后续动作

- 未处理审查标记为 Minor 的 probe 状态残留，严格遵从本轮范围；060 接入 UI 前应决定其重置策略。
