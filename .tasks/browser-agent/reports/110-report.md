# 110 组合验证报告

状态：DONE

## 根因与证据

失败来自两个旧集成测试过早结束运行生命周期，而不是新增浏览器工具行为：

- `client.integration.test.ts` 在调用两次 `sendMessage` 后固定等待 30ms 就读取请求。`sendMessage` 只完成会话提交调度，不保证模型 run 已进入终态。失败日志中第二个 run 尚未发出请求，实际只有 1 个请求。
- `multiClient.integration.test.ts` 只等待 `requests.length`，它观察的是请求开始，不是三个 run 完成。超时/断言后 `afterEach` 会 dispose 仍在 bootstrap 的 client。失败日志实际只有 2 个请求，并有两个尚在 `pluginHost.activateRun` 动态 import 的未处理拒绝。
- 基线 `756cd97` 在低并发下 19 files / 82 tests 全过，说明不是可直接归为既有 runtime 缺陷；当前新增工具测试在失败轮次也都通过。失败只落在上述两个生命周期等待不完整的旧测试。

## 修改

- 端点与密钥轮换测试现在等待旧、新会话的 `runAtom.status` 都为 `done`，再读取请求并执行原有端点、key、instructions 与 skill 快照断言。
- 三 Agent 隔离测试现在等待三个目标会话的 run 都为 `done`，再执行原有三请求、endpoint/model/prompt/tool/key 隔离和凭据隐藏断言。
- 等待仍有 1 秒上限；若 runtime 无法完成，测试会报告实际 run 状态，而不会靠无限轮询或放宽请求数量通过。
- 未修改 runtime、插件加载、隔离模式、预期值或并发配置。

两个存量测试文件修改后分别为 211 行和 179 行，均低于普通文件 300 行限制。

## 验证

1. 定向组合：`pnpm exec vitest run browser-agent/agent/src/client.integration.test.ts browser-agent/agent/src/multiClient.integration.test.ts`
   - 2 files passed，11 tests passed，无 unhandled errors。
   - 日志：`reports/110-targeted.log`
2. 最终完整组合：`pnpm exec vitest run browser-agent`
   - 27 files passed，107 tests passed，无失败、无 unhandled errors。
   - 日志：`reports/110-browser-agent.log`

最终组合覆盖新增 7 个业务工具、2 个 Skill 工具、extension bridge/UI fixture，以及原有 endpoint、skill 快照、key 轮换和多 client / 三 Agent 隔离合同。新增工具在原失败日志中已通过，修复只改变旧测试等待的完成条件，因此没有证据指向新增工具行为错误。
