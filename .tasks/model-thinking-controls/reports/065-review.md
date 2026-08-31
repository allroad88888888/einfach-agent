# 065 独立审查

## 结论

**APPROVE**

065 在声明文件面内闭合了 060 发现的语义断裂。`setComposerThinkingEffort` 只会在当前
`thinking === undefined`、capability 为 default-enabled effort、且所选值是合法具体 effort 时物化
`thinking: true`；没有发现相邻行为或 adapter fail-closed 防线回归。

## Findings

- Blocker：无。
- Important：无。
- Minor：无。

## 实现与回归核对

- `composerModelSettings.ts:113-129` 先保留 unsupported/unknown 的既有早退收窄，再独立计算 effort 与
  `thinking`。物化分支同时要求 `current.thinking === undefined`、`capability.kind === 'effort'`、
  `capability.defaultEnabled === true` 和 `isSupportedThinkingEffort(...)`；四项缺一即保留当前
  `thinking`。因此显式 `false` 不会被重开，显式 `true` 不变，default-disabled/未声明默认值也不会被
  物化。
- `auto` 不属于合法具体 effort，仍只删除 `reasoning_effort`；非法 effort 同样不进入结果。测试直接覆盖
  DeepSeek、GLM-5.2 的 implicit default-On、显式 false/true、Auto 和非法值。既有邻近用例继续覆盖
  toggle-only、unsupported、unknown，模型切换/profile identity/opaque bag 的 045 R1 契约也保持通过。
- 060 的 `ComposerModelControls.audit.test.tsx` 当前仍为报告记录的 53 行，保留两家 provider-default On、
  点击 Max 后必须得到 `thinking:true` 与 `reasoning_effort:'max'` 的原始强断言；2/2 现已通过，没有改成
  弱匹配或删除 wire 关键字段。该文件与两个 065 声明文件都处于共享未跟踪状态，Git 没有历史对象可做
  绝对 provenance 比较；但当前内容与 060 report/review 逐项描述一致，且文件修改时间早于 065 两个声明
  文件，未见 065 后改写迹象。
- adapter 防线未放松：`builtinProviders.ts:117-123` 仍要求 canonical Thinking 显式 enabled 后才发送合法
  effort；`thinkingRequestProjection.test.ts:82-98` 仍断言缺少显式 enabled 时 DeepSeek/GLM 均不得上行
  Thinking 或 effort。065 的修复只在 UI 设置转换边界补齐显式 `true`。

## 独立验证

- 065 最小测试、060 audit、045/050 相邻 UI 测试、capability 与 wire 协议测试合并复跑：
  **11 files / 109 tests passed**。
- `pnpm exec tsc -b --pretty false`：通过。
- `git diff --check`：通过；两个 065 未跟踪声明文件与 060 audit 分别执行
  `git diff --no-index --check /dev/null <file>`，均无 whitespace error。
- 行数：`composerModelSettings.ts` 138 行，`composerModelSettings.test.ts` 215 行，分别只负责设置转换与其
  纯函数测试，均低于 300 行；060 audit 仍为 53 行。

## 范围确认

完整读取 index、065 task/report、060 report/review、015/045/050 相关执行与审查报告，并核对两个声明
文件、060 audit、capability、core Thinking 投影及 adapter/wire 防线。除新增本 review 外未修改产品、
测试、task、index/status，未执行 commit/reset/stash，也未派发子 agent。
