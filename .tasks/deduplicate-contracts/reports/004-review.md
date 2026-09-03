# 004 R1 独立复审

## 结论

**APPROVED**：原 Important 已修复；旧 ASCII 映射语义恢复并由 Unicode 回归用例锁定，`.`/`..` 防逃逸仍成立。

## 复审范围

- 仅复核首审 Important：共享 sanitizer 的旧映射兼容性、Unicode 测试期望，以及 `.`/`..` containment。
- 依据原任务、更新后的执行报告、当前指定范围 diff 与范围内新文件。
- 按要求未重跑执行报告声称已运行的测试，也未修改产品代码。

## 原 Important 复核

### ✅ 恢复旧 ASCII 白名单语义

- `scripts/subagent-archive-paths.js:3-9` 现使用原有 `/[^a-zA-Z0-9._-]+/g` 白名单、首尾下划线清理与 96 字符截断。
- 这与指定 diff 中 replay、retention 两份旧 sanitizer 的常规 segment 映射一致；安全修复仅额外统一保留 retention 已有的 `safe !== '.' && safe !== '..'` 判定。
- 因此首审指出的 `a会b` 从旧 `a_b` 漂移为 `a会b`、纯 Unicode 从旧 `unknown` 漂移为原字符的问题均已消除。

### ✅ Unicode 测试锁定旧映射

- `scripts/subagent-archive-paths.test.js:17` 明确断言混合 Unicode `a会b` 映射为 `a_b`。
- `scripts/subagent-archive-paths.test.js:18` 明确断言纯 Unicode/空白组合 `会话\t编号` 映射为 `unknown`。
- 更新后的执行报告记录指定 Vitest 命令通过：3 个文件、16 个测试；本复审按要求未重跑。

### ✅ `.`/`..` 防逃逸仍成立

- `scripts/subagent-archive-paths.js:9` 在清洗和截断后将空结果、`.`、`..` 统一映射为 `unknown`。
- `scripts/subagent-archive-paths.js:17-21` 将两个安全 segment 拼到已解析 archive root 下，并用 `relative`/`isAbsolute` containment 判据拒绝逃逸结果。
- `scripts/subagent-archive-paths.test.js:14-15,25-35` 继续覆盖 `.`、`..`、正反分隔符及空值，并断言恶意 ID 得到 `conversations/unknown/runs/unknown` 下的固定 replay 文件路径。
- retention 接线测试仍在指定 diff 中验证 `--conversation .. --run .` 输出 `unknown/unknown`；新 replay 测试也通过共享路径函数构造相同恶意 ID 场景。

## 质量发现

### Critical

- 无。

### Important

- 无；首审 Important 已关闭。

### Minor

- 无。

## 最终判定

R1 精确修复了 Unicode 路径兼容性回归，未削弱任务要求的路径 containment，批准交付。
