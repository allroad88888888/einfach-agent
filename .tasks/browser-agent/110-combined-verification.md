---
id: '110'
title: 浏览器工具扩充在组合验证中稳定通过
kind: leaf
parent: browser-agent
depends_on: ['080', '090', '100']
discovered_from: '100'
model: gpt-5.6-sol
status: done
base: 756cd97
files:
  - browser-agent/agent/src/client.integration.test.ts
  - browser-agent/agent/src/multiClient.integration.test.ts
---
# 浏览器工具扩充在组合验证中稳定通过

仅可修改上述两个现有测试文件，不能改产品运行时；若证据表明需改runtime，先NEEDS_CONTEXT给编排明确根因和最小方案。报告写reports/110-report.md。不得启动浏览器、访问钥匙串或提交。读index全局约束。

080新增6页面工具、090新增数据源发现、100接线与UIfixture均独立review通过。root在最后验证遇到旧agent测试组合失败：reports/tools-final-tests.log 106项105过，client.integration第56行固定30ms后requests=[]；单独复验tools-client-recheck.log 8/8过；root低并发再跑reports/tools-final-tests-r1.log 107项105过，client.requests只有1，multiClient.requests只有2，并伴两个defaultCorePlugins is not iterable（packages/agent-core/src/runtime/core/pluginHost.ts:170动态import结果异常）。这次没有改agent/core运行代码。

root已建临时基线worktree，路径见reports/tools-baseline-path.txt，以HEAD756cd97+复用同一node_modules执行旧browser-agent --maxWorkers=2，19files/82tests全过，证据tools-baseline-tests.log。因此不能凭口述标既有问题；可能是异步测试清理/并发模块加载或本次组合影响。当前实现全量107项，新工具和bridge都过。

## 任务

追踪两个测试的异步等待/清理，隔离导致组合失败的条件。不要通过反复运行直到绿来掩盖问题。优先使测试等待实际run进入稳定终态再读断言与dispose，避免固定30ms或仅请求开始就结束测试。保留端点/skill快照/密钥轮换/三Agent隔离原断言，不能预加载内部plugin、mock内核、关闭隔离、禁用并发或放宽预期来掩盖运行缺陷。可用已建基线目录做有目的对照，不重装依赖/不改锁文件；测试日志输出到reports/110-*.log。

若证明是测试生命周期问题，修复这两处测试并验证原功能，最终一次运行pnpm exec vitest run browser-agent，要求无失败与unhandled errors。若是Vitest执行器与正确ESM加载的既有问题，需提供基线可复现证据及准确界限，报告DONE_WITH_CONCERNS由编排裁决，不随便改核心动态import。普通文件≤300行（存量文件若超限小改如实说明，不拆无关功能）。

交付报告需说明根因证据、为何不是新增工具行为错误、修改了什么、完整组合验证结果。所有具体工具实现已通过独立review，不需重审其代码。
