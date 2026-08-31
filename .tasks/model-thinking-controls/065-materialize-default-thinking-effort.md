---
id: "065"
title: 让默认开启模型的具体档位真实生效
kind: leaf
parent: "400"
depends_on:
  - "015"
  - "045"
  - "050"
discovered_from: "060"
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/composerModelSettings.ts
  - apps/web/src/agentNew/ui/composerModelSettings.test.ts
---

# 让默认开启模型的具体档位真实生效

## 目标

修复 060 发现的 UI→wire 语义断裂：当 capability 的 `defaultEnabled` 让缺省会话显示 Thinking On 时，
用户直接选择 High/Max 等具体 effort，转换结果必须物化 `thinking:true`，使 adapter 能真实发送该档位。

## 上下文

060 的独立终审与 reviewer 已证明 DeepSeek V4、GLM-5.2 均可复现：界面缺省显示 On，点击 Max 后只
持久化 `reasoning_effort:'max'`，而 adapter 在 `thinking` 未显式 enabled 时按既有 fail-closed 规则丢弃
effort。修复应放在 045 的纯设置转换边界，不得放松 020 的 wire 防线，也不得在 React 中复制默认规则。

只处理“用户选择具体合法 effort”的路径：

- `thinking === undefined` 且 capability `defaultEnabled === true` 时，写入 `thinking:true`；
- 已显式 `thinking:false` 时继续保留 false，不能让被禁用控件的程序化调用偷偷重开 Thinking；
- 已显式 `thinking:true` 时保持 true；
- Auto 仍以 effort 字段缺省表达，不新增字面量 `auto`；
- unsupported、toggle-only、unknown 与非法 effort 行为不得放宽。

060 的失败审计测试是验收证据，不在本叶文件面，禁止修改或弱化；允许读取和运行。

## 验收标准

1. `composerModelSettings.test.ts` 直接覆盖 default-On + concrete effort、显式 Off、显式 On、Auto、非法与
   unsupported/unknown 邻近语义。
2. `ComposerModelControls.audit.test.tsx` 的 DeepSeek 与 GLM-5.2 两例由 2/2 fail 变为 2/2 pass，且测试
   文件不被修改。
3. 045/050 既有专项测试、`pnpm exec tsc -b --pretty false` 与 `git diff --check` 通过。
4. 两个声明文件各自单一职责且不超过 300 行；不得修改其他产品、测试、task/index/report。
