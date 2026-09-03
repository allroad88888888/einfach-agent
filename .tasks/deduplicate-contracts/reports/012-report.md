# 012 执行报告

回执：`DONE`

## 摘要

- 新增 `shellCommandTool.ts`，集中处理 shell 参数归一化、危险文件写检测、timeout/output 限制、`ctx.runShell` 执行与统一错误结果映射。
- macOS、Linux、PowerShell 叶模块现仅声明工具名称、目标平台、现有描述/triggers 与各自 guide。
- 新增三平台参数化测试，锁定无 `runShell` capability、危险文件写、timeout、非零退出和成功输出的共同语义。

## 逐项验收

1. ✅ `pnpm vitest run tools/shell/src` 通过：8 files / 83 tests。
2. ✅ `shellCommandTool.test.ts` 对三个 descriptor 参数化覆盖无 capability、危险文件写、timeout、非零退出和成功输出。
3. ✅ 三个平台生产实现不再复制 execute/helper 主体；`shell_macos`、`shell_linux`、`shell_powershell` 的名字、platform 选择和 guide 导入保持不变。
4. ✅ `pnpm exec tsc -b tools/shell/tsconfig.json` 通过。
5. ✅ `git diff --check -- tools/shell/src` 通过；本次新增/大改文件均少于 300 行。

## 未验证

- 未运行全仓测试；已运行任务指定的 shell 域测试与 TypeScript 检查。

## 范围外发现

- 无。

## 疑虑

- 无。

## 建议

- 编排者可按任务范围审查并提交；无需额外实现工作。
