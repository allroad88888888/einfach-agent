# 060 R1 独立复审

## 结论

**APPROVE**

原 060 Important 已由 065 在正确的纯设置转换边界闭合，原审计没有被删减或弱化，adapter 的
fail-closed 防线也未放宽。DeepSeek V4 Pro 与 GLM-5.2 的 provider-default On→Max 现在都经真实
Composer→command 路径精确写入 `thinking:true` 与 `reasoning_effort:'max'`。C-00～C-12 均可认可为
PASS，060 R1 终审报告可靠。

## Findings

- Blocker：无。
- Important：无。
- Minor：无。

## 原 Important 闭合与审计强度

- `composerModelSettings.ts:108-129` 仅在四项条件同时成立时物化 `thinking:true`：当前值缺省、
  capability 为 effort、`defaultEnabled:true`、选择值是该 capability 的合法具体 effort。显式 false/true
  原样保留；Auto、非法值、toggle-only、unsupported、unknown 均不会进入物化分支。
- `composerModelSettings.test.ts:175-214` 直接覆盖 DeepSeek、GLM-5.2、显式 Off/On、Auto、非法值及
  无档位能力；既有 profile identity、跨 vendor 清袋、opaque bag 与不可变性测试保持通过。
- 原 060 audit 仍为 53 行，保留 DeepSeek 与 GLM 两例、初始 `aria-pressed=true`、点击 Max、完整
  Session settings 精确相等四层强断言。独立复跑为 2/2 PASS，没有改为部分匹配或删除
  `thinking:true`。
- `thinkingRequestProjection.test.ts:82-98` 仍要求缺少显式 enabled 时两家都不得发送 Thinking/effort；
  独立复跑全部 wire 用例通过。因此绿灯来自 UI 设置补齐显式 true，不是 adapter 放松约束。
- `modelSettingsPersistence.integration.test.ts:21-56` 仍以新 Core hydrate 完整 settings 并验证 sibling
  不变；独立复跑 1/1 PASS。

## C-00～C-12 复核

| 编号 | 结论 | 复核要点 |
| --- | --- | --- |
| C-00 | PASS | 官方默认显示、首次 toggle 与首次具体 effort 均有真实 command 证据。 |
| C-01 | PASS | DeepSeek 仅暴露 Auto/High/Max；显式 enabled、Auto 省略及 default-On→Max 均闭合。 |
| C-02 | PASS | GLM-5.2 正向档位、disabled alias、脏值过滤及 default-On→Max 均闭合。 |
| C-03 | PASS | 其余 GLM 为 toggle-only；wire 不发 effort，旧 GLM 不发 Thinking。 |
| C-04 | PASS | Kimi K2.6 为 toggle-only；无伪造 effort，既有消息编码保持。 |
| C-05 | PASS | 老 GLM unsupported，unknown/openai-compat 不继承内置 Thinking 能力。 |
| C-06 | PASS | command 的 updated/no-op/missing、时间戳、单次 persist 与 sibling 隔离完整。 |
| C-07 | PASS | UI 与 command 对全部 busy/settled 状态双层 fail closed。 |
| C-08 | PASS | 会话切换与新 Core hydrate 均证明完整 settings 不串话。 |
| C-09 | PASS | 17 个内置项、profile 多模型、安全 key/字段及 connectionId identity 有直接断言。 |
| C-10 | PASS | 13 个转换测试覆盖 profile、跨 vendor、opaque bag、capability 收窄及 065 新边界。 |
| C-11 | PASS | Auto 缺省、Off 不上行 effort、脏值过滤仍成立；adapter 负断言未放宽。 |
| C-12 | PASS | Web 回归、组件语义、focus、窄窗与 reduced-motion 证据保持完整。 |

## 独立验证

- 必需闭环：Composer audit、settings transition、wire projection、persistence integration —
  **4 files / 37 tests PASS**。
- agent-ai 全套：**28 files / 250 tests PASS**。
- core command/persistence/hydrate 专项：**5 files / 31 tests PASS**。
- Web 010～065 专项：**10 files / 61 tests PASS**。
- `pnpm exec tsc -b --pretty false`、`pnpm check:state`、`pnpm check:boundaries`、
  `git diff --check` 均通过；boundaries 只有已登记观察项。
- 中英文 catalog SHA-1 分别为报告所列
  `6794ed3be54a02d5dedbe8e702c884005bc5c84a`、
  `93d85b784a3efd108442217bc7dedaf92cdb8b3f`。Lingui/build 的 R1 记录与本轮仅改纯转换/测试的范围相容，
  未发现证据冲突。

## 视觉、共享红项与行数

- 065 只改纯设置转换及其测试，没有 DOM、文案或 CSS 变化。重新以原始分辨率检查 1440×900 桌面、
  640×900 中文与 640×900 英文三张原图，控件、六档 radio、授权、输入、附件与发送动作均无可见覆盖、
  截断或横向溢出；沿用 050 的 CDP/视觉证据合理。仓库仍无 `.shared/visual-runtime`，报告没有伪称运行
  visual lint。
- 当前 HEAD 等于基线 `c7befb48...`；基线本身同时含 temperature 投影与相反测试断言，R1 已正确把该
  core 全套红项归为基线矛盾，而非并行改动。BrowserActionCard 组件、render helper 与 i18n 目录仍有
  010～065 文件面之外的工作区改动，缺 I18nProvider 的两条红项归因也成立。
- 065 文件为 138/215 行，060 审计测试为 53/58 行；全树新增/大改普通文件均不超过 300 行。两份
  2048 行 PO 是 i18n 资源例外；359 行 `deepseek.test.ts` 是未修改的存量超限。预留但未创建的
  `thinkingControls.integration.test.ts` 与 `glm.test.ts` 已由现有专责闭环测试覆盖，不构成缺口。
- `060-report-r1.md` 为 113 行，职责单一且低于 300 行。

## 范围确认

完整读取更新后的 index、065 task/report/review、原 060 report/review 与 `060-report-r1.md`，并核对
修复源码、强审计、相邻协议、持久化、矩阵、门禁、视觉、共享红项归因及行数。除本 review 外未修改
产品、测试、task、index/status，未执行 commit/reset/stash，也未派发 subagent。
