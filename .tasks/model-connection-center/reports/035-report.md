# 035 执行报告：清理探测编辑上下文

## 改动摘要

- 在 create、edit 与 close 编辑器入口统一将 `modelConnectionProfileProbeStateAtom` 归为 `{ status: 'idle' }`；成功保存、删除与 settings 关闭均经既有 close 路径覆盖。
- `updateModelConnectionProfileDraft()` 仅在 `baseUrl` 的 trim 后值变化时清理 probe；标签、ID、模型与临时 Key 改动保留同地址探测结果。
- R1：以 `WeakMap<Store, number>` 保存非产品、非持久化的 probe 代次。所有上下文失效操作递增代次；过期 Promise 的 resolve/reject 均不再回写 ready/error。
- 添加可控 pending probe 的 baseUrl 与 create 切换回归，并在 `SettingsDialog.close.test.tsx` 直接通过 `closeSettingsCenter()` 建立 ready probe 后断言 idle。该测试文件原有夹具同步为当前 `models` 契约。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/agentNew/ui/SettingsDialog.close.test.tsx`
   - 通过：2 个测试文件、16 个测试均通过；包含 pending probe 过期静默丢弃及直接 `closeSettingsCenter()` 清理回归。
2. `pnpm check:state`
   - 通过：状态不变量检查扫描 867 个非测试 TS/TSX 文件，5 条规则全部通过。
3. `git diff --check`
   - 通过：无输出，退出码 0。
4. `wc -l apps/web/src/settings/modelConnectionProfileState.ts apps/web/src/settings/modelConnectionProfileCommands.ts apps/web/src/settings/modelConnectionProfileCommands.test.ts apps/web/src/agentNew/ui/SettingsDialog.close.test.tsx`
   - 通过：分别为 221、204、219、96 行，均不超过 300 行。

## 未验证项

- 未运行全仓 `pnpm exec tsc -b` 或 UI 集成测试；它们不属于本叶验收门，且依赖后续 060 UI 任务。

## 范围外发现

- 工作区已有大量用户在途改动；本任务限定的三个文件也处于未跟踪状态，因此普通 `git diff` 无法将本叶增量与前序未提交实现区分。未修改范围外文件。

## 疑虑

- 无功能性疑虑。当前上下文中的 probe 仍保留 loading/ready/error 行为；仅失效代次的完成被静默丢弃。

## 建议后续动作

- 进入独立审查；060 可直接消费已具备编辑上下文隔离的 probe atom。
