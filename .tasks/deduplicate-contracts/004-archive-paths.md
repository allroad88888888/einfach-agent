---
id: 004
title: 所有归档 CLI 使用同一安全路径映射
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 55a3d2e
files:
  - scripts/subagent-archive-paths.js
  - scripts/subagent-archive-paths.test.js
  - scripts/subagent-replay-report.js
  - scripts/subagent-replay-report.test.js
  - scripts/subagent-archive-retention.js
  - scripts/subagent-archive-retention.test.js
---

# 所有归档 CLI 使用同一安全路径映射

## 目标
让 replay 与 retention CLI 共用同一个 archive segment/path 模块，并保证 `.`、`..`、分隔符和空值不能逃出归档根目录。

## 交付边界
安全 segment、归档路径组装、两个 CLI 接线和恶意输入测试构成一个安全边界修复。不得改变 retention 的删除/恢复策略或 replay 的报告格式。

## 上下文
- `scripts/subagent-replay-report.js` 的 `safeSegment` 会保留 `.`/`..`。
- `scripts/subagent-archive-retention.js` 的副本会将二者映射为 `unknown`。
- 新模块名称必须体现 archive path 职责，不得成为 scripts 通用工具桶。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- Node `path.resolve/relative/isAbsolute`。
### 产出
- `safeArchiveSegment(value)` 及必要的归档 run path 纯函数，供两个 CLI 共同调用。

## 验收标准
1. `pnpm vitest run scripts/subagent-archive-paths.test.js scripts/subagent-replay-report.test.js scripts/subagent-archive-retention.test.js` → 全部通过。
2. 测试覆盖 `.`, `..`, `/`, `\\`, 空白、Unicode/控制字符、正常 ID；任何解析结果都位于预期 archive root 内。
3. `node scripts/subagent-replay-report.js --help` 与 `node scripts/subagent-archive-retention.js --help` → 退出码 0。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `55a3d2e`。
- 2026-09-03：首审 REJECTED，发现 Unicode ID 映射从旧 ASCII 行为漂移；R1 已恢复旧映射并补测试，待复审。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 16 tests 通过，准予提交。
