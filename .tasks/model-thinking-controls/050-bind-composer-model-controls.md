---
id: "050"
title: 绑定输入框模型控件
kind: leaf
parent: "400"
depends_on:
  - "015"
  - "030"
  - "040"
  - "045"
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/ActiveSessionProvider.tsx
  - apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx
  - apps/web/src/agentNew/ui/Composer.tsx
  - apps/web/src/agentNew/ui/Composer.test.tsx
  - apps/web/src/agentNew/ui/ComposerControlBar.tsx
  - apps/web/src/agentNew/ui/ComposerModelPicker.tsx
  - apps/web/src/agentNew/ui/ComposerModelPicker.css
  - apps/web/src/agentNew/ui/ComposerModelPicker.test.tsx
  - apps/web/src/agentNew/ui/ComposerThinkingControl.tsx
  - apps/web/src/agentNew/ui/ComposerThinkingControl.css
  - apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx
  - apps/web/src/agentNew/ui/ComposerModelControls.integration.test.tsx
---

# 绑定输入框模型控件

## 目标

让输入框控件操作当前会话的真实设置。

## 上下文

工作区已有用户确认视觉方向的未跟踪原型：`ComposerModelPicker`、`ComposerThinkingControl`、
`ComposerControlBar`，以及 `Composer.tsx` 的接线。必须保留其紧凑模型下拉、独立 Thinking 按钮和分段档位
外观，移除“仅预览”本地 state，改读 ActiveSession 的完整 settings、040 options、045 transitions 并调
030 command。

`ActiveSessionProvider` 需要给 render child 提供完整只读 ModelSettings 或等价完整字段，不得丢
thinking/vendorSettings。profile 列表从 Einfach atom 订阅。控件 disabled 语义以当前 run 是否允许设置变更
为准，并与 030 busy 防线一致；失败结果不得伪装成功。

交互要求：

- native select 或同等可访问下拉按内置/profile 分组，当前值受外部 session 切换驱动，不保留组件本地
  selected；选择后立即更新当前会话。
- Thinking 是 `aria-pressed` button；unsupported/unknown 时显示不可用说明或隐藏档位，但不能留下可点的
  假按钮。toggle-only 只显示按钮，effort 模型显示 Auto 与 capability 列表。
- 每个 radio group 的 name 必须按 session 唯一，两个 Composer 测试实例不能互相取消选择。
- 720px 以下换行但不横向溢出；长 profile/model label 省略且 title/accessible name 可读；保留现有
  授权、排队、附件、发送和 Shift+Tab 行为。
- focus-visible、disabled 对比度、reduced-motion 与中英文长度均可用。

`Composer.tsx` 当前 287 行：只做最小 props 接线；若超过 300 行，把模型控件协调抽到本任务新增的专责
组件/ hook，并在 frontmatter 执行记录中补文件，不得把发送逻辑机械切片。

## 接口

### 消费

- 030 `setActiveSessionModelSettings`。
- 040 options 与 045 transitions。

### 产出

- 当前会话可操作的模型/Thinking 控件和 C-07～C-12 组件证据；055 提取新文案，060 总审。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/ComposerModelPicker.test.tsx apps/web/src/agentNew/ui/ComposerThinkingControl.test.tsx apps/web/src/agentNew/ui/ComposerModelControls.integration.test.tsx` → 五类 capability、会话切换、busy、profile identity、快捷键回归通过。
2. `pnpm check:state && pnpm exec tsc -b apps/web/tsconfig.json && git diff --check` → 通过。
3. 启动本地界面，至少检查桌面宽窗口与 720px 以下窄窗口；捕获并检查截图、console 与请求失败。若
   `.shared/visual-runtime` 不存在，使用项目现有 dev server + 浏览器截图能力并在报告写明替代方法。
4. `wc -l` 检查全部新增/大改文件；`Composer.tsx` 不超过 300 行。

## 执行记录（仅编排者回写）

- 2026-08-21：首轮独立审查 REJECT：provider-default 的 `thinking: undefined` 被显示为 Off，首次点击
  不能按按钮承诺关闭。能力默认值拆为发现叶 015，本叶等待 015 后做限定 R1。
- 2026-08-21：015 完成后执行限定 R1；独立复审 APPROVE，上轮 High 闭合。
