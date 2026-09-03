# 004 archive paths report

## 改动摘要

- 新增 `scripts/subagent-archive-paths.js`，集中提供 `safeArchiveSegment`、单个 run 路径和 replay 文件路径组装；路径组装在返回前校验结果仍在 archive root 内。
- replay report 与 archive retention CLI 都改为使用该共享映射，`.`、`..`、空值会映射为 `unknown`；分隔符、空白和控制字符会被安全替换。
- 新增安全 segment/路径矩阵测试，并分别验证 replay、retention CLI 对恶意 run identity 的接线。
- 修复第 1 轮：共享 sanitizer 保持原有 ASCII 白名单；混合 Unicode ID 仍映射为 `_`，纯 Unicode ID 仍映射为 `unknown`，从而兼容既有归档寻址。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm vitest run scripts/subagent-archive-paths.test.js scripts/subagent-replay-report.test.js scripts/subagent-archive-retention.test.js` | 通过：3 个文件、16 个测试。覆盖 `.`, `..`, `/`, `\\`, 空白、Unicode、控制字符和正常 ID；Unicode 断言保持旧 ASCII 映射；各映射 run path 均在 archive root 内。 |
| `node scripts/subagent-replay-report.js --help` | 通过，退出码 0。 |
| `node scripts/subagent-archive-retention.js --help` | 通过，退出码 0。 |
| `git diff --check -- scripts/subagent-archive-paths.js scripts/subagent-archive-paths.test.js scripts/subagent-replay-report.js scripts/subagent-replay-report.test.js scripts/subagent-archive-retention.js scripts/subagent-archive-retention.test.js` | 通过，无 whitespace 错误。 |
| `wc -l`（上述 6 个产品/测试文件） | 通过：最大为 `scripts/subagent-archive-retention.js` 的 296 行，均未超过 300 行限制。 |

## 未验证项

- 无。

## 范围外发现

- 无。

## 疑虑

- 无。

## 建议后续动作

- 编排者审查并按任务 files 边界暂存、提交此交付。
