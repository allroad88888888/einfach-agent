---
id: "020"
title: 让 DeepSeek V4 支持三档 effort
kind: leaf
parent: "200"
depends_on: ["010"]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: 9d994a35128833c99897113755ceb8160e28b08f
files:
  - packages/agent-ai/src/deepseek.ts
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/deepseekCatalog.test.ts
  - packages/agent-ai/src/builtinThinkingCapabilities.test.ts
  - packages/agent-ai/src/thinkingRequestProjection.test.ts
  - packages/agent-ai/src/deepseekThinkingEffort.test.ts
  - packages/agent-core/src/state/persistence/modelMigration.ts
  - packages/agent-core/src/state/persistence/modelMigration.test.ts
---

# 让 DeepSeek V4 支持三档 effort

## 目标

把 DeepSeek V4 的有效手动档位修正为 low、high、max。

## 粒度

包含类型、catalog、wire 与历史值归一化一个协议闭环，预计 15–20 分钟。

## 上下文

当前类型与 catalog 只有 high/max，且历史归一化错误地把 low→high、xhigh→max。官方当前映射是
low→low、medium→high、high→high、xhigh→high、max→max。三个目标模型为 Pro、Flash、Vision Exp；
Vision 必须继续保留图片能力。

`builtinProviders.test.ts` 已 298 行，禁止追加；新断言放 `deepseekThinkingEffort.test.ts`。

## 覆盖矩阵行

- `C-02`、`C-03`、`C-09`：DeepSeek 档位、线上请求与 Vision 保留。

## 接口

### 消费

- 010 的 capability required 语义；DeepSeek 不设置 required。

### 产出

- `DeepSeekReasoningEffort = 'low' | 'high' | 'max'`。
- 三个 DeepSeek descriptor 的 efforts 精确为 `['low','high','max']`。

## 验收标准

1. low/high/max 在 enabled 时原样上行，Auto/Off/medium/xhigh/未知值不由 adapter 原样上行。
2. 历史归一化保留 low，medium/xhigh 归 high，非法值删除；迁移测试证明幂等。
3. 三个 DeepSeek 模型顺序、1M context 与 Vision image capability 不变。
4. DeepSeek 专项测试、`pnpm exec tsc -b --pretty false` 与 `git diff --check` 通过。

## 执行记录（仅编排者回写）

- 执行 DONE：6 files / 118 tests、类型、diff 与行数门通过。
- 独立 Sol reviewer APPROVED：四项验收及 C-02/C-03/C-09 均闭合，无质量发现。
- 编排者复跑协议、capability、持久化三组测试：3 files / 74 tests 通过。
