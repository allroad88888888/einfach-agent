---
id: 012
title: 三个平台 shell 工具共享同一执行内核
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 2d0fe21
files:
  - tools/shell/src/
---

# 三个平台 shell 工具共享同一执行内核

## 目标
macOS、Linux、PowerShell 工具通过一个 shell command tool factory 共享参数处理、安全写入检测、timeout、执行和错误结果语义。

## 交付边界
执行 factory、三个薄平台 descriptor、现有 guide/exports 和参数化行为测试必须一起交付。平台命令选择、工具名和用户可见文档保持不变。

## 上下文
- 三个平台实现各约 120 行，除 metadata/platform/guide 外，辅助函数和 execute 流程高度相同。
- 新文件建议命名 `shellCommandTool.ts`，只负责构造 shell command Tool；平台目录继续持有各自 guide。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- 现有 `detectShellFileWrite`、host shell capability 和 Tool contract。
### 产出
- `createShellCommandTool(descriptor)` 或等价 factory。

## 验收标准
1. `pnpm vitest run tools/shell/src` → 全部通过。
2. 参数化测试证明三平台对无 capability、危险文件写、timeout、非零退出与成功输出保持一致。
3. 三个平台叶实现不再复制 execute/helper 主体，工具名和 guide 不变。
4. `pnpm exec tsc -b tools/shell/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `2d0fe21`。
- 2026-09-03：执行 DONE；独立 reviewer APPROVED；编排者复跑 83 tests 通过，准予提交。
