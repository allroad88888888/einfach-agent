---
id: "055"
title: 接入根测试基础设施
kind: leaf
parent: "300"
depends_on:
  - "040"
discovered_from: "050"
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - vite.config.ts
  - scripts/state-invariants/sourceScopeTable.js
  - scripts/state-invariants/sourceFiles.js
  - scripts/state-invariants/sourceFiles.test.js
---

# 接入根测试基础设施

## 目标

使根测试基础设施正确识别原生桌面测试边界。

## 上下文

全量 `pnpm test` 暴露的是 discovery 接入问题：

- 三个由 `node` 直接执行的 `node:test` 文件命名为 `*.test.mjs`，被 Vitest/jsdom 再次收集；两个报
  no suite，一个因 jsdom 的跨 realm `Uint8Array` 破坏 esbuild invariant。它们仍由既有 Node 命令验收，
  Vitest 应在保留 `configDefaults.exclude` 的前提下精确排除 desktop `*.test.mjs` 与
  `scripts/stage-desktop-node-runtime.test.mjs`。
- 状态扫描只治理 TS/TSX。新增 `apps/desktop/src` 是 Rust-only 根，`sourceFiles.test.js` 却要求每个 `src`
  至少有一个受治理 TS 文件。例外必须在 `sourceScopeTable.js` 以精确根路径和理由登记，不能删除桌面根、
  扩大状态规则到 Rust 或放松其他 TS 根的非空断言。
- `UndoBar.tsx` 已被用户删除，扫描面 sentinel 应换成当前存在、确实消费 agent store 的 Web 生产文件；
  不得恢复 UndoBar。

`vite.config.ts` 当前 298 行，本叶最多增加到 300 行；若无法在两行内清晰完成，必须按职责抽取配置，而非
越过上限。不得改三个 Node 专项测试本身。

## 验收标准

1. `pnpm exec vitest run scripts/state-invariants/sourceFiles.test.js` → 9 项通过。
2. Vitest discovery 不含三个 Node 专项路径，同时仍发现普通 `.test.ts/.tsx/.js`；给出可复现 list 证据。
3. `pnpm check:state` 通过；Rust-only 例外精确为 `apps/desktop/src`，其余 TS source root 仍必须非空。
4. 扫描 sentinel 指向现存 Web 生产文件并附该文件为何能证明规则扫描面的理由。
5. `pnpm exec tsc -b --pretty false`、范围 `git diff --check` 与 `wc -l` 通过；`vite.config.ts` 不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-31：由全量测试的 3 个 suite discovery 失败与 2 个 state scan 自测失败发现。
- 2026-08-31：首次执行准确报告 `sourceFiles.js` 未在 files，无法消费精确 Rust-only root 表；编排者补入
  最小实现 owner 后以同模型继续，不计修复轮次。
- 2026-08-31：执行与独立审查通过；编排者复跑 sourceFiles 9/9、state、diff 与 300 行门全绿。
