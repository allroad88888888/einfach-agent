# 055 根测试基础设施执行报告

状态：DONE

## 修改范围

- `vite.config.ts`：保留 `configDefaults.exclude`，额外精确排除 `apps/desktop/**/*.test.mjs` 与 `scripts/stage-desktop-node-runtime.test.mjs`，避免三个 `node:test` 专项被 jsdom/Vitest 重复收集。
- `scripts/state-invariants/sourceScopeTable.js`：以带理由的精确键 `apps/desktop/src` 登记 Rust-only 根，不使用按目录名称的宽泛排除。
- `scripts/state-invariants/sourceFiles.js`：消费该登记；Rust-only root 不进入 TS/TSX 状态规则 roots，而该根未来出现 TS/TSX 时仍会由白名单外门禁失败。
- `scripts/state-invariants/sourceFiles.test.js`：Sentinel 从已删除的 UndoBar 更新为 `apps/web/src/agentNew/ui/MessageList.tsx`。该生产组件读取多个 `useAgentAtomValue` 的 agent-store atom，证明无 package.json 的 Web root 仍在扫描面内。测试同时断言唯一 Rust-only 例外为 `apps/desktop/src`，其余实际 TS source roots 仍必须非空。

`vite.config.ts` 在本任务开始前已含 Lingui 与 tools-vision 的在途修改；本任务只添加 `configDefaults` import 与测试 `exclude` 配置，未覆盖这些既有变更。

## 精确验证命令与结果

```text
pnpm exec vitest run scripts/state-invariants/sourceFiles.test.js
```

通过：`Test Files 1 passed (1)`，`Tests 9 passed (9)`。

```text
pnpm check:state
```

通过：扫描 22 个工作区 TS/TSX source roots 下的 900 个非测试文件，5 条状态规则均通过。

```text
pnpm exec vitest list --filesOnly --json | node -e "…"
```

通过：发现 705 个测试文件；普通 `scripts/state-invariants/sourceFiles.test.js`、`Composer.images.test.tsx`、`BrowserActionCard.test.tsx` 均存在；以下 Node 专项路径均不存在于 Vitest discovery：

- `apps/desktop/tests/desktopStaticGuard.test.mjs`
- `apps/desktop/tests/threeModeSmoke.test.mjs`
- `scripts/stage-desktop-node-runtime.test.mjs`

```text
pnpm exec tsc -b --pretty false
```

通过（退出码 0，无输出）。

```text
git diff --check -- vite.config.ts scripts/state-invariants/sourceScopeTable.js scripts/state-invariants/sourceFiles.js scripts/state-invariants/sourceFiles.test.js
```

通过（无输出）。

```text
wc -l vite.config.ts scripts/state-invariants/sourceScopeTable.js scripts/state-invariants/sourceFiles.js scripts/state-invariants/sourceFiles.test.js
```

通过：分别为 300、71、131、130 行；`vite.config.ts` 未超过 300 行，其他文件也均未超过 300 行。

## Diff 边界

产品/测试代码 diff 仅限任务声明的四个文件：

- `vite.config.ts`
- `scripts/state-invariants/sourceScopeTable.js`
- `scripts/state-invariants/sourceFiles.js`
- `scripts/state-invariants/sourceFiles.test.js`

本执行额外回写本报告：`.tasks/tauri-server-web-modes/reports/055-report.md`。
