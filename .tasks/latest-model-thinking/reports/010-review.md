# 010 独立审查

## 结论

APPROVED。指定范围 diff 满足四条验收标准，`C-04`、`C-06`、`C-13` 均有本叶实现与测试证据；未发现 Critical 或 Important 质量问题。执行报告存在一处覆盖编号误记，列为 Minor。

## 审查边界

- 仅依据任务文件 `010-required-thinking-contract.md`、执行报告 `010-report.md` 与指定 base/文件范围 diff。
- 按要求未重跑执行报告声称已运行的测试或检查。
- diff 外事项标为“⚠️无法核实”，不据此判失败。

## 验收标准逐条判定

### 1. required 控件语义

✅ 通过。

证据：

- `ModelThinkingCapability` 的两种 supported 分支均通过 `SupportedThinkingCapability` 获得只读可选字段 `required?: boolean`；`modelRequiresThinking()` 仅在 supported 且 `required === true` 时返回 true，省略字段保持 false。
- `ComposerThinkingControl.tsx` 使用 `effectiveEnabled = required || enabled`。required capability 即使收到 `enabled: false`，仍渲染 `aria-pressed="true"` 和 `On`，并以 `disabled || !supported || required` 禁止切换。
- required 状态的 `aria-label` 与 `title` 都是“Thinking 始终开启”。
- effort radio 的禁用条件改为 `disabled || !effectiveEnabled`，因此 required 状态下仍可选择档位。
- `ComposerThinkingControl.test.tsx` 用合成 required effort capability 验证：按钮 disabled、pressed 为 true、标题与无障碍名称明确、显示 On、Auto/Low/High/Max 存在、Low 可用、点击 Max 会触发 effort 回调且不会触发 toggle 回调。
- React 消费面只查询 provider-neutral capability helper，未按 vendor/model 字符串建立黑名单。

### 2. 设置转换与 optional 回归

✅ 通过。

证据：

- `normalizeThinkingSettings()` 在 required capability 下强制写入 `thinking: true`，覆盖选择模型时传入的关闭状态。
- `setComposerThinkingEnabled()` 在 required capability 下忽略程序化 `enabled: false`，保持 `thinking: true`。
- `setComposerThinkingEffort()` 在 required capability 下对具体 effort 与 Auto 均强制 `thinking: true`；effort 的写入/清除逻辑不变。
- `composerModelSettings.test.ts` 覆盖了选择 required 模型、程序化关闭、选择 `max`、切回 `auto` 四条路径。
- 对 optional capability，三处改动的非-required 分支均保留原逻辑；执行报告还记录原有测试随同本次 23 个测试全部通过。

### 3. 指定 Vitest 命令

✅ 通过。

证据：执行报告记录指定命令通过，结果为 3 个测试文件、23 个测试全部通过。依审查要求未重跑。

### 4. 单一职责与文件行数

✅ 通过。

证据：

- 执行报告记录七个声明文件依次为 100、80、104、119、143、248、199 行，均不超过 300 行。
- 一句话职责均成立：capability 文件定义并查询 Thinking 能力契约；其测试文件验证该契约；Control 文件渲染 Thinking 控件；其测试文件验证控件行为；Settings 文件转换 Composer 模型设置；其测试文件验证设置转换；CSS 文件描述该控件样式。
- 范围 diff 没有显示职责混杂或机械拆分；CSS 无需改动。

## 覆盖矩阵本叶证据

### C-04

✅ 本叶覆盖成立。

本叶以 provider-neutral 的 `required` 契约、`modelRequiresThinking()`、Composer 的强制 On/禁用关闭/effort 可选行为及 UI 测试，提供了任务上下文所述 GLM-5.3 强制 Thinking 的基础语义。

⚠️无法核实：实际 GLM-5.3 catalog 项是否声明 `required: true` 不在指定 diff 内；执行报告说明该接线属于后续 030，本叶不以 vendor/model 黑名单提前实现。

### C-06

✅ 本叶覆盖成立。

同一 provider-neutral 契约与 Composer 测试可表达 Kimi K3 始终思考，且实现不依赖供应商或型号判断。

⚠️无法核实：实际 Kimi K3 catalog 项是否声明 `required: true` 不在指定 diff 内；执行报告说明该接线属于后续 040。

### C-13

✅ 本叶覆盖成立。

`composerModelSettings.ts` 在模型选择、程序化开关与 effort 更新三个设置入口归一 required capability 为 `thinking: true`；`composerModelSettings.test.ts` 对上述转换提供直接测试证据。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. 执行报告的覆盖追踪编号错误：任务文件明确列出 `C-04`、`C-06`、`C-13`，但报告把设置转换写成 `C-14`，并进一步声称“010 任务文件所列”为 `C-14`。指定 diff 已提供 `C-13` 所需的设置转换证据，因此这是报告追踪性问题，不是实现或验收失败。

## 其他核实限制

- ⚠️无法核实 ESLint：执行报告称仓库环境没有 `eslint` 可执行文件；Lint 不是本任务列明的验收命令，故不计为 ❌。
- ⚠️无法核实浏览器视觉表现、整树 build、Lingui extract/compile 及最终总门；它们不在指定 diff/本叶验收证据内，故不计为 ❌。
