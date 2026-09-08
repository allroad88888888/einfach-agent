---
id: "020"
title: 强制运行时能力策略
kind: leaf
parent: "200"
depends_on: ["010"]
model: gpt-5.6-sol
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
done: 2026-09-08
files:
  - packages/agent-core/src/runtime/modelTurnPrefix.ts
  - packages/agent-core/src/runtime/modelTurnRequester.ts
  - packages/agent-core/src/runtime/toolLoopBootstrap.ts
  - packages/agent-core/src/runtime/toolEpoch.ts
  - packages/agent-core/src/runtime/runCapabilitySnapshotCache.ts
  - packages/agent-core/src/runtime/runCapabilitySnapshotCache.test.ts
  - packages/agent-core/src/runtime/turnToolSet.ts
  - packages/agent-core/src/runtime/turnToolVisibility.ts
  - packages/agent-core/src/runtime/toolCallGate.ts
  - packages/agent-core/src/runtime/toolCallExecutor.ts
  - packages/agent-core/src/runtime/toolContext.ts
  - packages/agent-core/src/runtime/toolContext/skillsCapabilities.ts
  - packages/agent-core/src/runtime/toolContext/delegationCapabilities.ts
  - packages/agent-core/src/runtime/**/*.test.ts
  - packages/agent-core/src/tools/**/*.test.ts
  - packages/agent-core/src/tools/context.ts
  - tools/skills/src/skill-search/skill-search.ts
  - tools/skills/src/skill-read/skill-read.ts
  - tools/skills/src/**/*.test.ts
  - .tasks/conversation-capabilities/reports/020-report.md
---

# 强制运行时能力策略

## 目标

让会话锁定 allowlist 成为一次 run 内工具和 Skill 可见性、schema、执行与子代理授权的共同安全边界。

## 前置契约

先阅读 `010-session-policy-contract.md`、010 report 和实际 diff。只消费 010 导出的纯判断/目录 API；
若接口与文档略有差异，以已审通过的代码为准并在报告写明。不得重新设计或复制策略状态机。

## 必须实现的语义

- 一次 run 开始时从 `SessionMeta` 取能力策略并形成不可变快照；运行中 registry 或草稿变化不得改变本 run。
- 工具 manifest、lazy `request_tool_schema` 可查询列表、schema 返回和实际顶层调用都与快照取交集。
- `ctx.callTool` 的递归调用也必须经过同一检查。仅在提示词中隐藏不算完成；未授权调用返回稳定、可诊断、
  不泄露完整隐藏目录的错误。
- `request_tool_schema`、`skill_search`、`skill_read` 按 010 控制工具规则始终可调用，但 schema 工具不得借此
  返回未授权业务工具。
- Skill manifest、`skill_search` 结果与 `skill_read`/解析都按同一 allowed skill name 集合过滤，稳定 name
  同时支持 built-in、`project/...`、`user/...`。直接猜测被禁 Skill 名称也必须读不到。
- 子代理不得扩大父会话权限：profile、host、registry 与会话 allowlist 逐层取交集；Skill 同理。禁用
  `delegate_agent` 时顶层根本不能发起委派。
- legacy-unrestricted 会话保持原行为；draft 仅可能在首条消息 commit 前短暂存在，运行时若意外收到 draft
  必须 fail closed 或先解析后固定，不能无界放行。
- 插件全局禁用、host 不可用、工作区 Skill 禁用仍是更高上界，即使 name 存在于会话 allowlist 也不可调用。

## 验收标准

1. 表驱动测试覆盖 tool manifest、schema list/schema fetch、顶层执行、递归 `callTool` 的 allow/deny。
2. 测试覆盖 built-in/project/user Skill 的 manifest/search/read 一致性与猜名拒绝。
3. 测试覆盖父/子代理权限交集、legacy 行为、draft fail-closed、运行期间 registry 变化不扩权。
4. 错误信息能指出会话配置拒绝该能力，但不枚举隐藏能力。
5. 相关 Vitest、`pnpm exec tsc -b --pretty false`、`git diff --check` 与声明文件 `wc -l` 全绿。
6. 报告写入 `reports/020-report.md`，列出精确文件、命令、结果与风险；不得 commit。

## 执行记录（仅编排者回写）

- 2026-09-08：依赖 010，当前阻塞。
- 2026-09-08：010 已验收，解除阻塞。
- 2026-09-08：已派发执行。
- 2026-09-08：两轮复审修复 late registration/Skill 猜名与同 run resume 快照漂移；最终独立审查 APPROVED。
