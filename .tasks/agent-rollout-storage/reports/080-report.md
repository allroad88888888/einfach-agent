# 080 report · R2

状态：DONE

## 完成内容

- Server Web adapter 精确映射 rollout host commands，并保留 host rejection。server bundle 只创建一个
  browser adapter 注入 core；static bundle 不带 rollout driver。
- Web 在 hydrate 前 reconcile：`warning.kind === 'source'` 拒绝启动，`projection` 只报告后继续。
- CLI 新增专责 persistence assembly：以同一默认 SQLite/app-data 路径装配真实 recovery、history log、
  `recoveryStore`、`historyFor` 和一个 direct Node rollout driver；root RecoveryWriter 与 child recorder
  从 core 取到相同 driver。
- 同一 CLI driver 注入 `createNodeHostInvoke` rollout routes 与 core。CLI host 借用该 driver，不登记
  rollout flush；CLI 只登记一个 composite persistence disposer，严格按 recovery tail → rollout flush 执行，
  MCP 仍保有独立 disposer。
- `CliShutdown.drain()` 关闭后续注册、等待所有 disposer，并向正常调用方传播单个错误或
  `AggregateError`；signal 无论 drain 成败都会退出，重复 drain 复用同一结果。
- borrowed host route 拒绝未注入 driver 的配置；其余默认 host 生命周期保持 host-owned 行为。
- Bootstrap lifetime 覆盖 assembly/reconcile：失败同样 drain；双失败以 `AggregateError` 保留 primary
  failure 为 cause 和首项。
- Runtime tests 通过绝对临时 SQLite 路径隔离；afterEach flush、reset core persistence、关闭 SQLite 连接并删除临时目录。

## 验证

- 15 个相关测试文件 — 81 passed；包含真实 `startModelRun(..., probeLoop)` 的 CLI 顺序断言：
  `reconcile → root append → model loop → recovery flush → rollout flush`。
- `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check` — passed。
- 所有 R1 owner 文件低于 300 行；最大 `main.tsx` 240 行。

## 说明

- HTTP driver 无浏览器端写队列，append 已 await server durability；其 `flush()` 合法为 no-op，Node host 持有的
  shared driver 才是实际队列 drain 边界。
- 未修改 task/index 或 owner 以外的产品文件；未 commit。
