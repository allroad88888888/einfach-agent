---
id: 030
title: 读取受限工作区图片
kind: leaf
parent: 200
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/host-node/src/commandNames.ts
  - packages/host-node/src/commandArgs.ts
  - packages/host-node/src/commandNames.test.ts
  - packages/host-node/src/createNodeHostInvoke.test.ts
  - packages/host-node/src/workspace/**
  - packages/host-node/src/commands/**
  - packages/host-node/src/index.ts
  - packages/agent-core/src/runtime/workspaceImageRead.ts
  - packages/agent-core/src/runtime/workspaceRead.ts
  - packages/agent-core/src/runtime/hostCommandBridge.ts
  - packages/agent-core/src/runtime/toolContext/workspaceCapabilities.ts
  - packages/agent-core/src/tools/types.ts
  - packages/agent-core/src/index.ts
  - packages/agent-core/src/**/*.test.ts
---

# 读取受限工作区图片

## 目标

新增只读图片字节能力：从显式路径读取 JPEG/PNG/WebP，执行 workspace root / Auto 外部只读权限、魔数、
大小与取消校验，并以受限 base64 结果交给后续视觉运行能力。不得把任意二进制读取变成模型可直接调用的
宽口命令。

## 粒度

预计 15–25 分钟；host 文件系统边界与 core ToolContext 守卫必须一起闭合才能机械验证“模型路径不能
越界”。若现有 command registry 需要触碰额外静态联合，限于为这一命令穿线并写入报告。

## 上下文

现有 `readWorkspaceFile` 只支持文本。沿用它的路径归一化、symlink/越界策略与
`withWorkspaceReadAccess`，但新命令必须只接受 JPEG/PNG/WebP 魔数并限制 20 MiB。返回值至少包括
`base64`、规范 MIME、原始文件名和 byte size；不要在错误中泄漏 workspace 外真实路径。

新文件职责计划：
- `packages/agent-core/src/runtime/workspaceImageRead.ts` → 只封装受管 host 图片读取命令。
- host-node 下新增文件 → 只实现受限图片读取命令，不混入通用 workspace 文本逻辑。

## 覆盖矩阵行

- `C-004`：工作区图片安全读取。

## 接口

### 消费
- `withWorkspaceReadAccess(input)`：来自现有 ToolContext workspace guard。
- host command bridge：来自 `runtime/hostCommandBridge.ts`。

### 产出
- `ToolContext.readWorkspaceImage?(input)`：输入 `path/workspaceRoot/allowExternalPaths/maxBytes`，返回受限图片 payload，供 050 消费。
- `WorkspaceImageReadResult`：包含 `base64`、`mimeType`、`filename`、`sizeBytes`。

## 验收标准

1. `pnpm exec vitest run packages/host-node/src/**/*workspace*image*.test.ts packages/agent-core/src/runtime/**/*workspace*image*.test.ts` → 正常、越界、伪扩展名、过大、取消覆盖通过。
2. `pnpm exec tsc -b packages/host-node/tsconfig.json packages/agent-core/tsconfig.json` → 类型检查通过或只剩明确记录的共享 worktree 前置错误。
3. `wc -l packages/agent-core/src/runtime/workspaceImageRead.ts packages/host-node/src/workspace/*image*.ts` → 普通文件均不超过 300 行。
4. `git diff --check -- packages/host-node packages/agent-core` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：已派发首轮实现。
- 2026-08-21：发现 host 静态命令名/参数/invoke 契约是新入口不可缺的注册面，精确扩入
  `commandNames.ts`、`commandArgs.ts` 及对应测试；不扩大业务目标。
- 2026-08-21：首轮独立审查 REJECTED。I-1：路径校验后按字符串 open 存在 symlink TOCTOU；I-2：
  open/read 失败可能回带 canonical 外部路径。进入 R1，要求把校验绑定到实际 file handle、稳定错误脱敏并
  补可控竞态测试；同时吸收 M-1，在 core 复核 20 MiB/调用上限与字节魔数。
- 2026-08-21：R1 复审仍 REJECTED。pathname 的二次 resolve 与 stat 之间仍可切换父目录，让外部
  handle 通过身份比较。进入 R2：confinement 必须只基于已打开 handle 的最终路径；Linux 用
  `/proc/self/fd/<fd>`，macOS 用固定参数 `lsof -a -p <pid> -d <fd> -Fn` 查询本进程 handle，无法可靠
  取得 handle 路径的平台或查询失败一律 fail-closed。不得再以 pathname stat 证明安全。
- 2026-08-21：R2 复审确认 fd-bound confinement 已闭合，但 REJECTED 新 Important：普通文件/平台
  校验前的阻塞式 POSIX open 可被无 writer FIFO 无限挂起。已达两轮上限，R3 升档给新 Sol/ultra
  执行者，仅补支持平台 open 前拒绝、`O_NONBLOCK` 与原 handle regular-file 校验及确定性测试。
- 2026-08-21：R3 以单一职责 opener 关闭 FIFO 阻塞，57 项图片测试和 11 项接线测试通过；最终独立
  复审 APPROVED。编排者复跑 7 文件 68/68 通过，C-004 完成。
