---
id: "020"
title: 提取共享 application-data 根目录
kind: leaf
parent: "1000"
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/appDataPath.ts
  - packages/host-node/src/appDataPath.test.ts
  - packages/host-node/src/sqlite/databasePath.ts
  - packages/host-node/src/sqlite/databasePath.test.ts
---

# 提取共享 application-data 根目录

## 目标

从 SQLite database path 中抽出跨平台 application-data 根目录解析，让 DB 与 rollout 共用同一个平台裁决。

## 上下文

现有 `databasePath.ts` 已包含 macOS、Windows、Linux 和 custom path 规则。030 若复制这套逻辑会产生漂移；
本叶只抽“应用数据根目录”职责，不改变现有 DB 默认路径。

## 接口

新增纯函数 `resolveAppDataDirectory(input)`，输入显式 platform/env/home/custom directory，输出
`com.webagent.app` 目录。`resolveSqliteDatabasePath()` 改为复用它；已有显式 `databasePath` 优先级保持不变。

030 将在该目录下使用 `rollouts/`。本叶不创建目录、不访问文件系统。

## 验收标准

1. table tests 覆盖 darwin、win32、Linux XDG、Linux fallback 与 custom directory。
2. 既有 database path tests 的输出逐项不变。
3. 缺失必要 home/env 时错误包含平台和缺失字段，不回退到 cwd。
4. `pnpm exec vitest run packages/host-node/src/appDataPath.test.ts packages/host-node/src/sqlite/databasePath.test.ts` → 通过。
5. 两个实现文件各不超过 300 行，职责描述都不含“和/以及”。

## 禁止项

- 不在本叶设计 rollout 文件名或建目录。
- 不读取真实用户环境完成测试；所有环境输入显式注入。
