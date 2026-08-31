---
id: "010"
title: 建立强制 Thinking 能力语义
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: 177676017b4f183fb9c10cbe3b92550c526d6b16
files:
  - packages/agent-ai/src/modelThinkingCapability.ts
  - packages/agent-ai/src/modelThinkingCapability.test.ts
  - apps/web/src/agentNew/ui/ComposerThinkingControl.tsx
  - apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx
  - apps/web/src/agentNew/ui/composerModelSettings.ts
  - apps/web/src/agentNew/ui/composerModelSettings.test.ts
  - apps/web/src/agentNew/ui/ComposerThinkingControl.css
---

# 建立强制 Thinking 能力语义

## 目标

让模型能力契约准确表达 Thinking 不可关闭。

## 粒度

这是一个跨 agent-ai 契约与 Composer 消费面的完整语义闭环，预计 15–20 分钟；拆开会让 UI 在契约尚未
可消费时出现临时黑名单。

## 上下文

当前 capability 只有 `defaultEnabled`，所有 supported 模型都会获得可点击的 Off。GLM-5.3 系列只接受
enabled，Kimi K3 始终思考，因此需要 provider-neutral 的 required/always-on 语义。不得在 React 中按
vendor/model 字符串判断。

## 覆盖矩阵行

- `C-04`、`C-06`、`C-13`：强制思考模型的控件与设置转换。

## 接口

### 消费

- 现有 `ModelThinkingCapability` 与 `modelSupportsThinking()`。

### 产出

- `modelRequiresThinking(capability: ModelThinkingCapability): boolean`：供 catalog、Composer 和请求投影使用。
- capability 的只读 required 字段：缺省为 false，避免改变现有模型。

## 验收标准

1. 合成 required capability 时，Composer 显示 On、不可切 Off、档位仍可选，aria/title 明确说明始终开启。
2. 选择 required 模型或程序化请求关闭时，设置转换保持 `thinking:true`；普通 optional 模型行为不变。
3. `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/composerModelSettings.test.ts` 全过。
4. 声明文件各自一句话职责成立，改后均不超过 300 行。

## 执行记录（仅编排者回写）

- 执行 DONE_WITH_CONCERNS：专项 23 tests、类型、diff 与行数门通过；eslint 命令不存在，不属于本叶验收。
- 独立 Sol reviewer APPROVED：四项验收与 C-04/C-06/C-13 覆盖成立，仅报告旧编号为 Minor。
- 编排者复跑三份专项测试：3 files / 23 tests 通过，准予分批提交。
