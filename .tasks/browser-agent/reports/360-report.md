# 360 全量并发回归稳定验证

状态：DONE

## 结论

本轮确认测试的 1 秒窗口结束时仍有 run 尚未完成；修复该生命周期竞态后，完整回归与负载验证均通过。动态 import 异常的精确根因未被独立证明。修复仅在两个既有集成测试中把固定 `100 × 10ms` 轮询改为 `runAtom` 订阅驱动的完成等待；三个请求、三个 run 为 `done`、endpoint/model/prompt/tool/key 隔离和凭据隐藏断言均保留。没有修改 `pluginHost.ts`、`defaultPlugins.ts` 或其他产品 runtime。

## 证据与边界

- 既有失败日志 `340-full-tests.log` 在断言处直接观测到三个 run 为 `['done', 'running', 'done']`，证明 1 秒窗口结束时 B 尚未完成；随后日志记录 B 的 `tool_calls_interrupted`，与失败后的 `afterEach.dispose()` 清理一致。
- 同一日志在失败报告后列出 `TypeError: defaultCorePlugins is not iterable`，栈位于 `pluginHost.activateRun` 的动态 import 之后。Vitest 明确提示该异常可能在测试完成后产生。结合尚在 running 的 B 和 teardown interruption，可判定测试没有等待真实终态，清理与异步 bootstrap 发生交叠。
- 日志输出分组不能证明动态 import 异常的精确墙钟时刻，也不能解释测试执行器为何得到不完整 namespace。因此本轮不把它归为已证实的产品模块初始化缺陷，也不声称是基线旧 bug。
- 无额外负载时，修改前的原命令曾通过 261 files / 2076 tests；这说明问题依赖调度时序，但单次通过不能关闭故障。

## 修改

- `client.integration.test.ts`：订阅两个目标 session 的 `runAtom`，两者都进入 `done` 后才检查请求与快照隔离。
- `multiClient.integration.test.ts`：订阅跨两个 client 的 A/B/C 三个 session，三者都进入 `done` 后才执行原隔离断言。
- 等待由状态变更事件驱动，不再每 10ms sleep；4 秒保护超时会报告每个未完成 run 的 label/status，并在成功或失败时解除全部订阅。

## 验证

1. 定向最终验证：
   `pnpm exec vitest run browser-agent/agent/src/client.integration.test.ts browser-agent/agent/src/multiClient.integration.test.ts`
   - 2 files passed，11 tests passed，无 unhandled errors。
   - 日志：`360-targeted-final.log`。
2. 负载稳定性：目标组合在并行 `pnpm exec tsc -b --force` 期间连续运行 10 轮，每轮均 2 files / 11 tests passed，无 unhandled errors；TypeScript 构建通过。
3. 340 R1 冻结后的最终原命令：
   `pnpm exec vitest run packages/agent-core/src packages/persistence-idb/src browser-agent/agent/src browser-agent/ui/src`
   - 261 files passed，2078 tests passed，退出码 0，无 unhandled errors。
   - 日志：`360-full-final.log`。
4. `git diff --check` 通过。修改后的两个测试文件为 227 行和 194 行，均低于普通文件 300 行限制。

源码已冻结，等待独立审查。
