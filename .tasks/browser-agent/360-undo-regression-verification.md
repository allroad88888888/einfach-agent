---
id: '360'
title: 全量并发回归稳定验证真实多Agent运行
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: '340'
model: gpt-5.6-sol
status: done
base: 756cd9768da1a8a69a233b5c6e0c691e41949f6f
files:
  - browser-agent/agent/src/multiClient.integration.test.ts
  - browser-agent/agent/src/client.integration.test.ts
  - packages/agent-core/src/runtime/core/pluginHost.ts
  - packages/agent-core/src/runtime/core/plugins/defaultPlugins.ts
---

340用户要求任意时间任一点undo，产品已完成并冻结，350独立审查中；编排需要全量验证可靠收口。你只诊断/修复本次完整回归实际暴露的运行问题，不碰340其他源码。

精确复现：`pnpm exec vitest run packages/agent-core/src packages/persistence-idb/src browser-agent/agent/src browser-agent/ui/src`。340执行首轮261files/2076tests有2个旧U14断言+1multiClient错误；U14更新后编排重跑日志reports/340-full-tests.log仍1 failed/2075 passed，并有unhandled `TypeError: defaultCorePlugins is not iterable`，pluginHost.ts:168动态import→170spread。失败multiClient第一个三Agent并发用例run状态有未done。

现存测试等待3run done，但只有100次×10ms=1s窗口，失败后afterEach会dispose。这可能是负载导致测试结束时动态import仍未完成，也可能是真正并发加载/循环依赖产品缺陷，**不能未经证据认定旧flake**。历史110报告修过类似问题，读reports/110-report.md作背景但不当本轮结论。定向multiClient 3/3通过不能独自关闭完整组合失败。

调查真实失败顺序和根因：是否在测试超时/afterEach后才爆import，是否module初始化并发、340新增import边导致环、返回半初始化namespace；必要时对340-before做隔离前态对照（可临时只读checkout，禁止重置/覆盖工作树）。不要只延长sleep/放宽断言、预加载defaultPlugins、mock内核、关掉isolate或跳过用例。若是测试生命周期必须等待真实终态，按明确受控等待机制修，仍保持3requests、三run done、endpoint/model/prompt/tool/key隔离断言；若是产品并发缺陷，限定pluginHost/defaultPlugins真实可复现最小修复并补回归。若文件范围需扩大先短报root。

相关单文件普通≤300（one-file skill）。只改上述范围及绝对报告`.tasks/browser-agent/reports/360-report.md`，无浏览器/模型/依赖安装/commit/push。完成后提供根因证据+最终原命令完整通过与无unhandled errors；不可只说单文件绿。产品源码改动前先说明设计和必要性。最大复修按tasktree规则；root负责独立审核和重构建。

最终收口：340 R1由350独立PASS，360独立PASS；261files/2078tests完整回归通过，无unhandled errors。根build、core/IDB/browser runtime/UI/extension/embedded构建及治理门禁通过。产物与真实浏览器边界见reports/340-verification.md。无commit/push/远程issue。
