# 050 report

## 已完成

- `ActiveSessionProvider` 现在向 render child 与会话子树 context 提供完整
  `ModelSettings`，保留 `thinking`、`temperature`、`vendorSettings.connectionId`、
  `reasoning_effort` 与 opaque 字段；不在 UI 建立副本真值源。
- `Composer` 只做最小接线：从 active-session context 读 settings，将运行态的 fail-closed
  disabled 语义传给 `ComposerControlBar`，同时用同一 settings 驱动原有图片能力判定。
- `ComposerControlBar` 订阅 `modelConnectionProfilesAtom`，消费 040 的全量选项与稳定 key，
  按 010 capability 查询目标模型，经 045 的三类转换生成完整 settings，再调用 030
  `setActiveSessionModelSettings`。原型中的 `useState` 已全部移除。
- 模型 select 是外部受控的 native control，按当前模型、内置 catalog 与 profile label
  分组；长 label 可省略显示，但 label/option 保留完整 `title`。
- Thinking 保留紧凑开关与分段档位：DeepSeek 仅 Auto/High/Max，GLM-5.2 为
  Auto/Low/Medium/High/XHigh/Max，toggle-only 只显示开关，unsupported/unknown 显示
  不可用理由且没有可点假档位。`aria-pressed`、radio 语义、会话唯一 radio name、
  focus-visible 与 reduced-motion 均保留。
- 任意非终态 run（running、awaiting_tool、三类等待态、interrupted）禁用模型与
  Thinking 控件；终态恢复。控件始终受 active session 驱动，command 拒绝时不会在
  界面伪造成功状态。

## 测试与门禁

- 叶任务指定的 5 个测试文件：`5 files / 30 tests passed`。
  - Provider 证明完整 opaque settings 进入子树。
  - Picker/Thinking 组件测试覆盖分组、长 label、busy、DeepSeek、GLM-5.2、
    toggle-only、unsupported、unknown 与两个会话 radio name 隔离。
  - 集成测试使用真实 defaultCore command，证明 profile `connectionId` 精确写入、
    sibling session 不变、会话切换受控更新、Thinking effort/toggle 落盘与全 busy 状态禁用。
- 额外回归：`ActiveSessionProvider` + `Composer` + 图片附件 + `AppShell` 共
  `7 files / 48 tests passed`，Shift+Tab、授权模式、排队、附件与发送链路无回归。
- `pnpm exec tsc -b tsconfig.app.json --pretty false` 通过；仓库不存在任务文字中的
  `apps/web/tsconfig.json`，因此使用真实覆盖 Web 源码的根 `tsconfig.app.json`。
- `pnpm check:state`、`pnpm check:boundaries`、`git diff --check` 通过；未跟踪原型文件另以
  `git diff --no-index --check` 逐个通过。边界命令仅报现有豁免观察项。
- `pnpm build` 通过；Vite 仅报现有 dynamic/static import 与大 chunk 提示。

## 实机视觉与可访问性

仓库没有 `.shared/visual-runtime`，因此按 frontend-design-codex 使用以下替代：

1. `pnpm dev --host 127.0.0.1`启动真实 Vite 界面。
2. 使用本机 Chromium headless shell 的 CDP 设置 viewport、操作真实 native select/Thinking
   按钮、捕获 PNG，同时订阅 `Runtime.exceptionThrown`、`Log.entryAdded` 与
   `Network.loadingFailed`。

证据：

- 宽屏 `1440x900`：GLM-5.2 + Thinking On + Max 正确反映持久化状态；
  `documentElement.scrollWidth === clientWidth === 1440`，status 与 actions 不重叠。截图位于
  `/tmp/model-thinking-050-desktop-final2.png`。
- 窄屏 `640x900`（小于 720px）：首轮截图发现发送按钮覆盖 Thinking 行，已将
  窄屏收敛为模型一行、Thinking 开关/档位两行、actions 独立末行。复拍结果
  `scrollWidth === clientWidth === 640`、status/actions `overlap=false`，6 个 GLM 档位每项约
  46px，无文字挤连。截图位于 `/tmp/model-thinking-050-narrow-final3.png`。
- 同一 640px 界面切换 English，长授权文案后 `status.scrollWidth <= status.width`，无横向
  溢出；截图位于 `/tmp/model-thinking-050-narrow-en.png`。
- 页面稳定后三次 CDP 捕获的 console warning/error、runtime exception 与非取消 request
  failure 均为 0。Chromium 进程在 CDP 订阅前的首次启动仍打印仓库现有 Lingui
  `Messages for locale "zh-CN" not loaded.` 时序提示，随后目录正常激活；本叶未修改该全局启动时序。
- 模拟 `prefers-reduced-motion: reduce` 后 option/group/glyph 的 `transitionDuration` 均为 `0s`；
  native model select 可聚焦，聚焦时外层出现 2px focus ring。

## 文件与范围

- 新增/大改文件均不超过 300 行；其中 `Composer.tsx` 293 行，不需要新增专责
  接线文件或扩大任务 files。其余主要产品文件：ControlBar 125 行、Picker 88 行、
  Thinking 99 行、Picker CSS 79 行、Thinking CSS 199 行。
- 只修改 050 声明的产品/测试文件并新增本报告；未修改 task/index，未修改 PO 目录
  （新文案留给 055），未暂存、提交或覆盖共享 worktree 的其他在途改动。

## R1：provider default Thinking

- 已闭合 `reports/050-review.md` 的唯一 High。`ComposerControlBar` 现在按以下顺序投影
  Thinking 开关：会话显式 `settings.thinking` → 受审 capability `defaultEnabled` → `false`。
  只有 `toggle|effort` capability 会读取 provider default；`unsupported|unknown` 始终投影为
  不可用/false。
- 因此 `thinking === undefined` 不再伪装成显式 Off。当 015 受审的 DeepSeek effort 与
  Kimi toggle-only 默认为开启时，按钮初始显示 On，第一次点击直接向 030 command
  写入 `settings.thinking=false`，而不是先写入 `true`。
- 新增两条真实 defaultCore 集成用例：DeepSeek V4 Pro（effort）与 Kimi K2.6
  （toggle-only）的会话均不写 `thinking`，断言初始 `aria-pressed=true`、首次点击后
  session settings 为 `thinking:false`且只持久化一次。组件测试同时证明显式 `true`
  首次点击上报 `false`，显式 `false` 首次点击上报 `true`。
- R1 指定测试：`5 files / 32 tests passed`；扩展 Composer/AppShell/附件回归：
  `7 files / 50 tests passed`。Web `tsc -b tsconfig.app.json`、`check:state`、`pnpm build`、
  tracked/untracked diff check 全部通过；build 仅保留上轮已记录的仓库级 chunk 提示。
- R1 未修改 DOM 结构、文案或 CSS，因此布局与上轮验收的
  `/tmp/model-thinking-050-desktop-final2.png`、`/tmp/model-thinking-050-narrow-final3.png` 及
  `/tmp/model-thinking-050-narrow-en.png` 一致，复用上轮宽/窄屏证据；该证据本身已是 On
  状态，无需为纯语义修复重复捕获。
- R1 最终行数：ControlBar 127、Thinking component test 91、integration test 135；
  `Composer.tsx` 仍为 293，全部低于 300 行。未修改 review/task/index/PO。
