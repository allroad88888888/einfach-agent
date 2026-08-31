# 060 独立终审复核

## 结论

**APPROVE — 认可 060 的终审结论；模型 Thinking 控件产品树仍应 REJECT。**

`060-report.md` 的核心发现可独立复现，严重度定为 Important 合理。缺省 Thinking 依 capability 显示为
On 时，直接选择具体 effort 只持久化 `reasoning_effort`，没有把界面当前承诺的 On 收敛为
`settings.thinking:true`；随后 core 省略 `thinking`，adapter 按 fail-closed 契约同时省略 effort。
DeepSeek V4 Pro 与 GLM-5.2 均受影响。C-00～C-02 因此未闭合，任务树不能标 done。

## Findings

### Blocker

无。

### Important

无针对终审报告的新 Important；确认报告中的一项产品 Important 成立：

- `builtinModelDescriptors.ts:58-70` 给 DeepSeek V4 与 GLM-5.2 声明 `defaultEnabled:true`；
  `ComposerControlBar.tsx:64-69` 因而在会话未存 `thinking` 时显示 On，并允许操作 effort。
- `ComposerControlBar.tsx:105-108` 把选择交给 `setComposerThinkingEffort`，而
  `composerModelSettings.ts:108-123` 最终仍以 `current.thinking` 写回；缺省值不会被物化成 `true`。
- `modelTurnRequester.ts:74-77` 将缺省 `thinking` 投影为 `undefined`；
  `builtinProviders.ts:117-123` 只有 canonical Thinking 为 enabled 时才发送合法 effort。
  `thinkingRequestProjection.test.ts:82-98` 直接钉住两家在未显式 enabled 时均不发 effort。
- 独立复跑 `ComposerModelControls.audit.test.tsx`：2/2 稳定失败；两例初始按钮均为
  `aria-pressed=true`，点击 Max 后收到的 settings 都仅含 `reasoning_effort:'max'`，相对预期均缺
  `thinking:true`。这证明不是仅有显示差异，而是 UI→command→wire 的真实语义断裂。

### Minor

1. **core 全套红测的来源措辞不准确。** `060-report.md` 将
   `modelRun.requestProjection.test.ts:53` 的 temperature 失败归因于“并行在途改动”；但当前
   `HEAD` 正是任务基线 `c7befb48...`，且 `git show <base>` 已同时包含
   `modelTurnRequester.ts:215` 对 `temperature` 的投影和该测试“不应含 temperature”的相反断言，相关
   文件也没有工作区改动。因此它是基线已有矛盾，不是并行在途改动。它仍明确不属于 010～060 文件面，
   不影响本树 Important 或 REJECT。BrowserActionCard 的两条 I18nProvider 失败则可由树外组件/i18n
   工作区改动直接解释，原报告归因成立。

## C-00～C-12 复核

| 编号 | 复核结论 | 核心依据 |
| --- | --- | --- |
| C-00 | **FAIL，认可** | provider default 的显示与首次 toggle 已有正向证据，但 default-On 下首次 effort 点击未使所选档位生效。 |
| C-01 | **FAIL，认可** | DeepSeek 档位表、显式 enabled/Auto wire 正确；default-On 直接选 Max 的完整路径失败。 |
| C-02 | **FAIL，认可** | GLM-5.2 正向档位与脏值过滤正确；default-On 直接选 Max 的完整路径失败。 |
| C-03 | PASS | descriptor 将其余 GLM 设为 toggle-only；协议测试证明不发 effort，旧 GLM 不发 Thinking。 |
| C-04 | PASS | Kimi K2.6 为 toggle-only；协议与 Kimi 消息测试证明无伪造 effort、消息编码保留。 |
| C-05 | PASS | 精确 capability lookup、unsupported/unknown/openai-compat 的组件与 wire 负断言完整。 |
| C-06 | PASS | command 覆盖 updated/no-op/missing、时间戳、单次 persist 与 sibling 隔离。 |
| C-07 | PASS | UI 与 command 使用同一 settled 集；全部非终态逐项禁用/拒绝。 |
| C-08 | PASS | 060 持久化测试经新 Core hydrate 精确恢复完整 settings，且 sibling 不变；独立复跑 1/1 通过。 |
| C-09 | PASS | 17 个内置项、profile 多模型、安全 key/字段边界及 `openai-compat + connectionId` 写入均有直接断言。 |
| C-10 | PASS | 12 个 transition 测试覆盖跨 vendor、profile identity、合法 opaque bag 与 capability 收窄。 |
| C-11 | PASS | Auto 删除 effort、Off 不上行 effort及脏值 fail closed 均成立；本次 Important 是另一条具体 effort 路径。 |
| C-12 | PASS | 组件/回归测试与 CSS 覆盖 native select、aria、radio name、busy、Shift+Tab、focus、窄窗及 reduced-motion。 |

## 独立验证摘要

- 最小组合复跑：wire 协议 21/21、持久化 1/1 通过；060 Web 审计 2/2 按预期失败。
- 9 个 Web 专项加 command/persistence：11 files / 64 tests 通过；其中报告所列 Web 部分仍为
  9 files / 58 tests。
- 非本树红测复跑：core request projection 1 条 temperature 失败；BrowserActionCard 2 条缺
  I18nProvider 失败。前者归因更正见 Minor，后者归因正确。
- 原始分辨率检查三张证据图：1440×900 桌面、640×900 中文、640×900 英文均存在且可读；控件、六档
  radio、授权状态、输入区与发送动作无可见覆盖、截断或横向溢出。源码同时具备 focus 与
  reduced-motion 规则。仓库确无 `.shared/visual-runtime`，060 没有伪称执行 visual lint。
- 两个实际新增的 060 测试分别 53/58 行且职责单一。任务预留的
  `thinkingControls.integration.test.ts` 未创建，因既有 wire 测试已经足够，不构成缺口。
- 全树声明文件机械复核：新增/大改普通文件均不超过 300 行；两份 2048 行 PO 属 i18n 资源例外；
  `deepseek.test.ts` 359 行为未修改的存量超限。`060-report.md` 120 行，本 review 低于 300 行。

## 范围确认

完整读取 index、060 任务与全部既有 reports，复核两个 060 测试、直接产品链路、相邻协议测试、共享
失败归因、三张视觉证据及物理行数。除本 review 外未修改产品、测试、task、index/status，未执行
commit/reset/stash，也未派发子 agent。
