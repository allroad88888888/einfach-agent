# 110 独立审查

## 结论

**PASSED**。110 正确定位并修复了两个旧集成测试的生命周期等待问题，没有修改产品 runtime、预加载插件、关闭并发、放宽业务断言或掩盖未处理异常。未发现 Critical、Important 或 Minor 级问题。

## 根因与修正核对

- ✅ `client.integration.test.ts` 原来在两次 `sendMessage` 后固定等待 30ms。该时间只是假定模型 run 已完成；失败日志中第二个请求尚未发出。修正改为读取两个精确 session store 的 `runAtom.status`，有界等待两者均为 `done`，并在原 URL、authorization、instructions 与 skill 快照断言前明确断言终态。
- ✅ `multiClient.integration.test.ts` 原来只等待 `requests.length === 3`。请求开始不能证明三个 run 已结束，测试退出后的 `afterEach` 可能 dispose 尚处于插件 bootstrap 的 client，对应失败轮次中的动态 import 未处理拒绝。修正对两 client 上三个精确 session 的 `runAtom.status` 作有界终态等待，再执行原三请求及 endpoint/model/prompt/tool/key 隔离断言。
- ✅ 两处等待均最多 100 次、每次 10ms；runtime 未完成时会以实际状态数组失败，不会无限等待或靠重复运行碰绿。
- ✅ 修改只涉及任务允许的两个测试文件，共 14 行新增、2 行删除；未改运行代码、mock、预期数量、隔离方式或 Vitest 并发配置。两个文件均低于 300 行。

## 验收证据

- ✅ 定向组合日志 `110-targeted.log`：2 files / 11 tests 通过，无 unhandled errors。
- ✅ 默认并发完整日志 `110-browser-agent.log`：27 files / 107 tests 全部通过，无失败、无 unhandled errors。该命令没有通过禁用并发规避原组合条件。
- ✅ 编排最终根 `tsc -b` 通过；成功命令无 stdout，`tools-final-types-r1.log` 为空文件与该行为一致。
- ✅ `tools-final-dist.log`：22 个 packed packages、32 个公开 ESM 入口、CSS、NodeNext declarations 与负导出检查通过。
- ✅ 原失败日志和基线 82 项通过证据仍保留。110 没有把问题简单归为基线缺陷；修正解释了为何增量测试在失败轮次通过、失败却落在两个未等待 run 终态的旧测试。

按独立审查规则未重复运行已记录通过的测试，未修改产品代码。

## Findings

无。
