# 界面截图清单

给发布物料（README/落地页）准备的界面截图任务清单。所有场景均已对照
实际组件代码核实，未来实现变化时请回来同步本文件里的组件路径与前置状态描述。

截图统一用 `pnpm serve` 起本机服务、在浏览器里截图——**那就是完整形态**：本机能力（文件、shell、
MCP stdio、模型代理）都由 `apps/server` 承接。本文原来还给出「用 `pnpm tauri dev` 起桌面窗口截真机
图」的口径，桌面端已随 T1 删除，那条路不存在了。`pnpm dev` 起的纯前端预览**不要用来截图**：它没有
后端，模型请求会被直接拒绝，MCP、文件与 shell 工具整类不进模型清单，截出来的是一个能力残缺的界面。

## 通用要求

- **凭据**：截图前先在 `~/.webAgent/config.json`（或对应环境变量）配置一个真实可用的模型 Key，
  保证能触发真实的模型回复、流式生成与工具调用；不要用假 Key 硬造静态 UI。
- **主题**：核对过 `apps/web/src/agentNew/ui/agentnew.css`，当前只有一套浅色配色，没有
  `prefers-color-scheme` / `data-theme` 分支，也没有深浅色切换开关——所有截图统一浅色即可，
  不需要额外出暗色版本。
- **窗口尺寸**：建议浏览器窗口不小于 1440×900，保证两栏布局（左侧工作区+会话列表、右侧对话）和弹窗
  内容都不需要横向滚动即可完整入镜。
- **通用马赛克清单**（凡出现以下内容都要打码或替换为占位文案）：
  - 本机真实文件系统路径中的用户名/机器名段（如 `/Users/<真实用户名>/...`），工作区根目录路径、
    MCP stdio 命令的 `cwd`、`.webAgent-archive/` 归档路径都属于这一类；
  - 任何凭据值（API Key、token）；MCP 环境变量确认卡片本身只显示键名不显示值，不需要额外处理；
  - 真实业务会话内容如果涉及非公开信息，要么换成示例任务重新跑一遍，要么局部打码。
- **文件命名**：`docs/launch/assets/<slug>.png`（`docs/launch/assets/` 目录目前还没有图，先按本文件
  给出的文件名占位，出图后再建目录放进去）。

## 场景清单

1. 会话流 + 流式回复
2. 计划审批
3. 树形子 Agent
4. 危险工具确认（含极高风险变体）
5. Trace Viewer
6. MCP 设置面板
7. MCP 起进程确认
8. 多工作区 / 多会话切换（加分）
9. 计划阶段回滚（加分）

---

### 1. 会话流 + 流式回复

**卖点**：主对话界面的实时打字机流式回复、思考过程可折叠、工具调用卡片按时间自然穿插在消息流
里——这是产品最日常的使用画面，也是第一眼印象。

**涉及组件**：`apps/web/src/agentNew/ui/AppShell.tsx` 组装的右栏，核心是
`apps/web/src/agentNew/ui/MessageList.tsx`（时间线渲染委托给
`apps/web/src/agentNew/ui/MessageTimelineRenderer.tsx` 与
`apps/web/src/agentNew/ui/ThinkingTimelineRenderers.tsx`），叠加
`apps/web/src/agentNew/ui/ToolActivity.tsx`（工具进度条）与
`apps/web/src/agentNew/ui/Composer.tsx`（输入区，运行中会变成"停止"按钮）。

**前置状态**：选中一个已经有几轮历史消息的会话，发一条会触发工具调用且回复较长的指令（例如"读一下
这个文件，总结要点，并说明理由"）。趁模型仍在流式吐字、`ToolActivity` 的进度行同时显示"某工具正在
执行…"文案时截图，画面里同时能看到：历史消息气泡、正在流式生成中的未完文本、工具进度条、以及
`Composer` 处于运行态（发送按钮变为"停止"）。

**构图要点**：整窗口截图，左栏 `apps/web/src/agentNew/ui/SessionList.tsx` 保留 2-3 个历史会话标题
增加真实感；右栏从消息列表顶部到输入区底部完整入镜。

**文件命名**：`docs/launch/assets/session-streaming.png`

---

### 2. 计划审批

**卖点**：面对复杂多步任务，模型会先拆解成分阶段计划，等人点头批准才开始执行——把控制权交还给
用户，是安全可控定位的直接体现。

**涉及组件**：`apps/web/src/agentNew/ui/PlanPanel.tsx`（通过
`apps/web/src/agentNew/ui/ActivePlanPanel.tsx` 挂在 `AppShell` 里，紧贴输入区上方）。

**前置状态**：发一个足够复杂、值得拆阶段的任务（例如"帮我重构 X 模块：先补测试，再改实现，最后跑
一遍全部测试并汇报结果"），促使模型调用 `create_plan` 生成计划。计划生成完毕后 run 会停在
`waiting_plan_approval`，`PlanPanel` 头部状态变为"等待决策"（未批准前显示"待批准"），底部出现
"请确认这份计划后再开始执行"的批准/拒绝按钮条。点一下"展开"让计划详情（objective、各阶段标题与
依赖）都可见。

**构图要点**：右栏局部截图即可，从计划面板头部到底部批准按钮条整体入镜；至少展开 2-3 个阶段，让
阶段状态徽标（待开始/进行中等）有对比。

**文件命名**：`docs/launch/assets/plan-approval.png`

---

### 3. 树形子 Agent

**卖点**：主 Agent 能把子任务派发给多个子 Agent 并行/串行执行，UI 上能看到树状进度和每个节点的
完整运行轨迹——多 Agent 编排是差异化能力，值得单独展示。

**涉及组件**：`apps/web/src/agentNew/ui/SubagentTreePanel.tsx`（默认折叠的 `<details>`，展开后渲染
`apps/web/src/agentNew/ui/SubagentTreeView.tsx` 的节点列表），选中节点后右侧详情面板里的
`apps/web/src/agentNew/ui/SubagentRunTrace.tsx` 展示完整运行轨迹。

**前置状态**：发一条会触发 `delegate_agent` 工具的指令（例如"分别用两个子 agent 调研 A 方案和 B
方案的优劣，然后帮我汇总对比"），等到至少出现 2-3 个子任务节点（运行中/已完成状态都占一个更好）。
点开 `SubagentTreePanel` 的 `<summary>`（"子 agent 运行记录"）展开面板，再点选一个节点，让右侧
`aside` 详情区（目标、状态徽标、运行轨迹）一起出现。

**构图要点**：整窗口或右栏局部，保证树形节点的状态徽标颜色（排队/运行中/完成/失败等）与缩进层级
清晰可辨，右侧详情栏一并入镜。

**文件命名**：`docs/launch/assets/subagent-tree.png`

---

### 4. 危险工具确认（含极高风险变体）

**卖点**：任何有破坏性的操作（改文件、跑 shell 命令）执行前都会先弹出确认卡，摊开风险等级和具体
参数，用户点头才真的执行——这是"安全可控"最直观的一张图，建议做两张：普通"危险"与"极高风险"各一张。

**涉及组件**：`apps/web/src/agentNew/ui/ToolConfirmCard.tsx`（挂在 `AppShell` 里 Composer 正上方）。

**前置状态（dangerous，普通危险）**：发一条会触发 shell 类工具（macOS 下是 `shell_macos`）执行非
只读命令的指令（例如"帮我删掉这个临时文件"或"跑一下 npm install"）。run 会停在
`waiting_confirmation`，卡片标题为"需要确认"，参数预览区显示具体命令原文，并带一个"本 session
一律允许该工具"勾选框。

**前置状态（critical，极高风险，加分变体）**：诱导出会命中递归强删/格式化一类判定的命令（例如让
模型对某个目录执行 `rm -rf`）。此时卡片标题变为红色系"极高风险操作"，且没有"一律允许"勾选框
（`ToolConfirmCard.tsx` 里 `irreversible` 为真时该勾选框会被隐藏）。

**构图要点**：局部截图，卡片从 header 到底部"拒绝/允许"按钮完整入镜；命令参数预览如涉及真实本机
路径按通用马赛克清单处理。

**文件命名**：`docs/launch/assets/tool-confirm-dangerous.png`、
`docs/launch/assets/tool-confirm-critical.png`

---

### 5. Trace Viewer

**卖点**：面向开发者/高级用户的可观测性面板，能看到每次 run 完整的 span/event 时间线与请求响应
预览，用于调试问题和建立信任——技术向受众很吃这张图。

**涉及组件**：`apps/web/src/traceViewer/TraceViewer.tsx`，通过 URL 查询参数 `?view=traces` 独立
渲染（见 `apps/web/src/main.tsx` 里 `currentView()` 分支与 `renderTraceViewer()`）。

**前置状态**：先正常跑几轮对话（最好包含一次工具调用、一次会报错或被取消的 run，这样 Runs 列表里
能看到不同状态色块和高亮 chip 的对比），然后在地址栏加上 `?view=traces` 打开独立的 trace 页面。
选中一个 run，再点开时间线里的一个 span，让右侧 Details 面板展开出 request/response 预览。

**构图要点**：整窗口截图，Runs / Timeline / Details 三栏都要入镜。

**额外马赛克提醒**：Details 面板的 request/response 预览会带出真实用户 prompt 与 system 指令，按
通用马赛克清单里"真实业务会话内容"处理；正常情况下这里不会出现裸 API Key，但截图前建议扫一眼
`attrs` JSON 确认没有异常泄出的凭据字段。

**文件命名**：`docs/launch/assets/trace-viewer.png`

---

### 6. MCP 设置面板

**卖点**：可以自由接入任意 MCP 服务，把外部工具挂给 Agent 用，是可扩展性的核心卖点。

**涉及组件**：`apps/web/src/agentNew/ui/SettingsDialog.tsx` 里"MCP 服务"这个 tab，渲染
`apps/web/src/agentNew/ui/McpSettingsPanel.tsx`；列表项是
`apps/web/src/agentNew/ui/McpServerCard.tsx`，卡片里的工具清单来自
`apps/web/src/agentNew/ui/McpServerToolSummary.tsx`。

**前置状态**：点击左栏底部"设置"按钮打开设置弹窗（`apps/web/src/agentNew/ui/SettingsCenter.tsx`
里的启动按钮），切到"MCP 服务" tab。预先添加至少两个服务：一个 Streamable HTTP 已连接、一个 stdio
（要起本机子进程，所以必须是 `pnpm serve` 那一态才连得上），展开已连接服务的工具清单摘要，
让"已连接"绿色状态点、工具数量、地址/命令这些信息都可见。

**构图要点**：整窗口截图（设置是 `<dialog>` 模态弹层），确保弹窗内容完整可见、不需要横向滚动。

**文件命名**：`docs/launch/assets/mcp-settings.png`

---

### 7. MCP 起进程确认

**卖点**：stdio 类型的 MCP 服务要在本机起进程，执行前必须把完整命令行摊给用户看，而不是静默执行——
这是产品在"外部工具接入"这件本身有风险的事情上额外做的一层安全设计，值得单独讲清楚。

**涉及组件**：`apps/web/src/agentNew/ui/McpLaunchConsentPrompt.tsx`，渲染在触发它的
`apps/web/src/agentNew/ui/McpServerCard.tsx` 卡片内部（不是独立弹窗）。

**前置状态**：在 MCP 设置里新增一个 stdio 服务（或导入一份包含 stdio 服务的配置）。第一次点击
"连接"，或者开启"自动连接"开关时，会先弹出"需要确认：将在本机执行命令"的提示区，展示完整命令行、
工作目录，以及涉及的环境变量键名（值已隐藏）。

**构图要点**：局部截图，聚焦该服务卡片，确认区从"需要确认"标题到"确认并执行/暂不执行"两个按钮
完整入镜。

**额外马赛克提醒**：命令行和工作目录几乎必然带出本机用户名路径，务必按通用马赛克清单打码；
环境变量只显示键名，一般不需要打码，除非键名本身暴露了内部系统名称。

**文件命名**：`docs/launch/assets/mcp-launch-consent.png`

---

### 8. 多工作区 / 多会话切换（加分）

**卖点**：可以并行管理多个项目工作区，每个工作区下的会话相互隔离，适合同时跑多个项目的重度用户。

**涉及组件**：`apps/web/src/agentNew/ui/WorkspaceSidebar.tsx` 与
`apps/web/src/agentNew/ui/SessionList.tsx`。

**前置状态**：新建 2-3 个工作区（指向不同的项目目录），每个工作区下建 2 个以上会话；展开其中一个
工作区的会话列表、其余工作区保持折叠，制造出"层级 + 数量"的观感。

**构图要点**：左栏局部截图即可。

**文件命名**：`docs/launch/assets/workspace-sessions.png`

---

### 9. 计划阶段回滚（加分）

**卖点**：执行到一半发现某个阶段方向不对，可以直接回滚到该阶段开始前的快照、连对话一起撤回——
试错成本低，呼应"安全可控"这条主线。

**涉及组件**：`apps/web/src/agentNew/ui/PlanPanel.tsx` 里每个阶段卡片自带的"回滚"按钮（点击调用
`rollbackPlanStage` 命令）。

> 补充说明：仓库里还有一个 `apps/web/src/agentNew/ui/CheckpointBar.tsx` 组件（按轮回退），但目前
> 没有被 `AppShell` 或任何页面挂载渲染，实际界面里看不到它，因此不纳入本清单——真实可触达的"回退"
> 入口是这里说的计划阶段回滚按钮。

**前置状态**：让一个计划至少跑完 1-2 个阶段（阶段状态变为"已完成"或"进行中"，此时"回滚"按钮不再
`disabled`）。把鼠标悬停在某个已完成阶段的"回滚"按钮上，等浏览器原生 tooltip 弹出
（"回到该阶段开始前：恢复当时的计划快照，并撤回该阶段之后的对话"）再截图；如果工具链截不到原生
tooltip，退而求其次只保证按钮处于可点（非置灰）状态即可。

**构图要点**：局部截图，聚焦该阶段卡片标题行和"回滚"按钮/tooltip。

**文件命名**：`docs/launch/assets/plan-stage-rollback.png`
