# 030 R1 独立复审：管理连接模型草稿

## 结论

**APPROVED**：上一轮“trim 后为空的模型 ID 可通过 valid/save”Important 已闭合；更新后的聚焦验收具有实现与回归测试证据，未发现新的 Critical 或 Important。

## 审查范围与方法

- 仅依据更新后的任务文件 `030-profile-model-state.md`、执行报告 `030-report.md` 与任务列出的 7 个文件范围 diff。
- 7 个任务文件当前均未被 Git 跟踪，逐个使用 `git diff --no-index -- /dev/null <file> || true` 审阅。
- 本轮只复审上一轮 Important 的闭合情况与更新后的聚焦验收；按指示未重跑报告声明的定向 Vitest、`pnpm check:state`、`git diff --check`，也未运行属于 060 总门的全仓 TypeScript 检查。
- 范围 diff 显示文件分别为 203、196、157、28、115、48、107 行，均不超过普通文件 300 行上限；R1 新增的共享判定仍属于连接模型草稿状态不变量，没有破坏单一职责。

## 上一轮 Important 闭合判定

✅ **已闭合：空白模型 ID 不再能通过有效性与保存校验。**

- `modelConnectionProfileState.ts` 新增 `hasModelIds(models)`：要求数组非空，且每个 `model.id.trim().length > 0`。
- `modelConnectionProfileValidAtom` 使用同一判定，因此仅含空白 ID 的模型草稿不会显示为有效。
- `modelConnectionProfileCommands.ts` 的 `saveInput()` 在完成字段 trim 后再次调用 `hasModelIds(input.models)`；这是最终 host 调用前的命令层防线，不依赖 UI 是否正确过滤输入。
- `modelConnectionProfileCommands.test.ts` 新增 `{ id: '   ', label: 'Blank', source: 'manual' }` 回归断言：valid 为 false、保存返回 false，并以 `saved()` 为 undefined 证明未调用 host save；随后换成有效模型仍可成功保存，覆盖临时 Key 没有被错误清除或泄漏的连续流程。

## 更新后的聚焦验收

### 1. 定向状态与 transport 测试

✅ **满足（依据执行报告及范围测试）。** 报告声明 3 个测试文件、15 个测试全部通过；本轮新增断言直接覆盖上一轮缺口。原有范围证据仍表明：

- probe 只读取当前草稿 `baseUrl` 与临时 `apiKey`，成功结果只进入独立 probe state，不覆盖已选模型；错误状态不保存 Key。
- 成功保存、取消、成功删除及 settings close 均清空密码草稿；密码不进入 public profile、probe state 或 transport registry。
- 编辑旧 profile 以对象复制方式完整带入所有模型。
- 默认运行时只有在精确 `(connectionId, model)` 成员存在时映射；缺失时 runtime 回退为 undefined，不改持久化偏好。
- `replaceOpenAiCompatConnections()` 显式投影为 `{ id, kind, baseUrl }`，运行时传入的额外模型与 Key 字段被丢弃，probe 输出也没有进入该调用链。

### 2. `pnpm check:state`

✅ **满足（依据执行报告）。** R1 报告声明状态不变量检查通过；新增校验是 Einfach 派生状态与命令层共享的纯判定，没有引入框架本地业务状态。

### 3. `git diff --check`

✅ **满足（依据执行报告）。** R1 报告声明命令无输出；本轮按指示未重跑。

## 质量发现

### Critical

无。

### Important

无。上一轮 Important 已闭合。

### Minor

1. **probe 状态未随编辑器上下文重置（沿用上一轮记录）。** 打开 create/edit、取消或关闭编辑器时只重置 draft，没有将 `probe` 恢复为 idle；上一个连接的探测结果可能在下一个编辑会话继续可见。按 R1 范围与任务执行记录，此项不作为本轮失败；060 接入 UI 前应明确由命令层或 UI 消费层处理其重置策略。

## 最终判定

上一轮阻塞项已修复并具备回归覆盖，030 可以通过 R1 独立复审。
