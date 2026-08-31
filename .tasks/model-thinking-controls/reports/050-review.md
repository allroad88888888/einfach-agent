# 050 独立审查

## 结论

**REJECT**

实现基本闭合了完整 `ModelSettings` 受控读取、模型/profile identity、command 写入、全部 busy 状态、五类 capability、会话切换、Auto/effort、radio name、既有 Composer 行为与窄窗视觉；但 `settings.thinking === undefined` 被错误显示为显式 Off，首次点击也因此可能执行与用户意图相反的动作。这是会直接误导并错误修改当前会话真实模型设置的阻塞缺陷。

## Findings

### High

1. **provider-default 被伪装成 Off，且默认开启模型的首次点击无法关闭 Thinking。**

   - `apps/web/src/agentNew/ui/ComposerControlBar.tsx:93-101` 把 `enabled` 固定投影为 `modelSettings.thinking === true`，所以缺省字段一律变成 `false`；随后 `ComposerThinkingControl` 在 `apps/web/src/agentNew/ui/ComposerThinkingControl.tsx:50-62` 对用户宣称 `aria-pressed=false`、`Thinking 已关闭，点击开启` 和可见 `Off`，点击则调用 `onToggle(true)`。
   - 但缺省字段不是 Off。请求真值在 `packages/agent-core/src/runtime/modelTurnRequester.ts:74-76`：`thinking === undefined` 会保持 `undefined`，最终省略该字段并交给 provider 默认行为。能力契约也专门预留了 `defaultEnabled`（`packages/agent-ai/src/modelThinkingCapability.ts:5-8`），当前 UI 完全没有消费它。
   - 结果是所有新会话、旧会话或切模型后仍为缺省 Thinking 的受支持模型都会显示一个并不存在的显式 Off。若 provider 默认开启，用户看到 Off 后第一次点击只会写入 `thinking: true`，请求行为没有关闭，必须再点第二次才会写 `false`；按钮显示、持久化状态和实际请求语义不一致。
   - 当前测试没有覆盖该状态：`ComposerThinkingControl.test.tsx` 的默认 props 与 capability 场景均传显式 `enabled`，集成测试的两个 session 也都写了 `thinking: true`（`ComposerModelControls.integration.test.tsx:34-44`）。应增加受支持 effort、toggle-only 模型的 `thinking` 缺省用例，钉住真实显示和首次点击结果；修复需明确使用受审 provider 默认值，或以不冒充 On/Off 的真实 provider-default 状态表达，并确保首次点击语义与按钮承诺一致。

### Medium

无。

### Low

无。

## 其余审查结果

- `ActiveSessionProvider.tsx:67-82` 直接从 active session meta 提供完整 `settings`，`Composer.tsx:49-50` 与 `ComposerControlBar` 只消费该外部值；未发现 UI-only `ModelSettings` 真值副本或本地 selected/thinking state。
- 当前 option 以 `vendor + model + connectionId` 匹配；profile 选择保持 `vendor: 'openai-compat'` 与精确 `connectionId`，集成测试证明 sibling session 不变。缺失 catalog/profile 的当前模型仍保留受控 current option。
- 三类 handler 都从当前完整 settings 经 045 transition 生成整值，再调用 030 command。UI 没有乐观更新；`busy/missing/unchanged` 不会伪造选择成功。命令返回值虽未用于提示，但受控值只随 root session 真值变化，满足本叶“失败不得伪装成功”的行为要求。
- UI 与命令层使用相同 settled 集：`idle/done/stopped/error` 可改，其余现有 `RunStatus`（`running/awaiting_tool/waiting_user/waiting_confirmation/waiting_plan_approval/interrupted`）均锁定。集成测试逐项覆盖全部状态。
- DeepSeek effort、GLM-5.2 effort、Kimi/toggle-only、unsupported、unknown 五类均有组件证据；Auto 以缺省 `reasoning_effort` 表达，非法/跨模型 effort 由 045 收窄。radio name 包含 session id，测试中的两组 name 不冲突。
- 新增文案使用 Lingui macro；`Thinking`、`Auto/Low/Medium/High/XHigh/Max`、`On/Off/N/A` 是原型保留的技术标签，未发现新增中文字符串绕过提取。055 仍需按任务树更新目录。
- 原授权按钮与 Shift+Tab、排队状态、附件、发送/停止路径仍在；指定 Composer 回归测试通过。`Composer.tsx` 为 293 行，其余 050 新增/大改文件也都不超过 300 行，文件职责未发现硬规则违规。

## 视觉与 CSS 证据

- 已实际检查 `/tmp/model-thinking-050-desktop-final2.png`（1440×900）、`/tmp/model-thinking-050-narrow-final3.png`（640×900）和 `/tmp/model-thinking-050-narrow-en.png`（640×900）。桌面层级清楚；窄窗下 model、Thinking toggle、effort、授权文案和 actions 分行，无可见截断、覆盖或横向溢出；英文长文案也未挤压发送按钮。
- `ComposerModelPicker.css:16-19` 与 `ComposerThinkingControl.css:50-53,161-164` 提供键盘 focus ring；`ComposerThinkingControl.css:166-191` 在 720px 以下换行；`:193-199` 在 reduced-motion 下移除本叶动画。disabled 对比度与截图可读性未见阻塞问题。

## 复跑验证

- `pnpm exec vitest run`（050 指定 5 个文件）：**5 files / 30 tests passed**。
- `pnpm exec tsc -b tsconfig.app.json --pretty false`：通过。
- `pnpm check:state`：通过。
- `pnpm check:boundaries`：通过，仅输出仓库已有豁免观察项。
- `pnpm build`：通过，仅输出既有 dynamic/static import 与大 chunk 提示。
- 声明文件 tracked diff、未跟踪文件 `git diff --no-index --check` 及物理行数均已核对；未发现 whitespace error。

## 范围确认

审查完整读取 index、030/040/045/050 任务与报告、050 全部声明文件及相对基线/未跟踪 diff，并追读 Thinking 请求投影和 capability 契约以确认缺省语义。除本 review 外未修改产品代码、任务、index，未暂存、提交或派发子 agent。
