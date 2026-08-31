---
id: "060"
title: 审核模型控件全链路
kind: leaf
parent: "400"
depends_on:
  - "020"
  - "030"
  - "050"
  - "055"
  - "065"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/thinkingControls.integration.test.ts
  - packages/agent-core/src/runtime/modelSettingsPersistence.integration.test.ts
  - apps/web/src/agentNew/ui/ComposerModelControls.audit.test.tsx
---

# 审核模型控件全链路

## 目标

证明模型控件从界面到线协议完整闭合。

## 上下文

这是 coverage audit 叶，不新增产品能力。先逐行检查 index 的 C-01～C-12；已有测试足够时引用其命令与
断言位置，不为凑文件制造重复测试。只有缺少跨层证据时才在本任务声明的三个专责 integration test 中
补最小用例。

重点审计：

- registry capability 与 adapter 最终 fetch body 是否同源，unknown/fallback 是否误获 DeepSeek 能力；
- command 更新的 SessionMeta 是否被 persistence projection 保存并可 hydrate，另一个会话是否不变；
- ActiveSessionProvider → options/transitions → command 是否没有 UI-only 真值源；
- profile connectionId 是否从 select 一直留到请求身份，且 Base URL/Key 没进入会话与 UI option；
- busy 状态是否 UI/command 双层拒绝，正在执行的 model snapshot 不被热切；
- desktop/narrow、中英文、键盘、长标签、无 effort/toggle-only/unsupported/unknown 的视觉状态。

运行真实桌面或 dev 界面只做本地视觉验收，不调用真实模型。报告必须列出覆盖矩阵每一行的证据、截图
检查方法、console/request failure 结果、所有命令输出摘要和遗留 Minor；Important 以上发现退回原任务
修复后重审，不能在审计叶顺手改产品代码。

## 验收标准

1. C-01～C-12 每行均有测试、源码与必要的实机视觉证据；报告中无“推测通过”。
2. 运行 010～055 全部专项 Vitest，再运行本任务新增 integration tests（若有）→ 全部通过。
3. `pnpm exec tsc -b && pnpm check:state && pnpm check:boundaries && pnpm lingui:extract --clean && pnpm lingui:compile && pnpm build && git diff --check` → 全部通过。
4. `wc -l` 检查全树新增/大改普通文件均不超过 300 行；路过存量超限在报告列出但不扩范围重构。
5. 独立 reviewer 基于基线与全部未跟踪文件复审通过后，本树方可标 done。
