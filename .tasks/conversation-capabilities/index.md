# 会话级工具与 Skills 配置

创建：2026-09-08

基线：`0fb3afbdf656df7184134075887aa414eb348828`

状态：已完成

## 目标边界

为每个新对话增加独立的工具与 Skill 配置。空白对话处于草稿态，可编辑；首条有效用户消息被接受时，
配置原子锁定并随会话持久化。锁定后 UI 只读，命令层与运行时同样拒绝修改或越权调用，并可复制相同
配置创建一个新的草稿对话。

本树不改变模型设置、thinking、审批模式、插件信任开关或工作区 Skill 开关。全局/工作区开关继续是
安全上界与新对话默认值，会话配置只允许进一步收窄，不能绕过这些上界。

## 产品裁决

- 草稿采用“默认全选 + 记录取消项”；锁定时写成工具与 Skill 的具体 allowlist。这样动态注册项只会进入
  尚未锁定的新草稿，不会悄悄扩张已锁定对话。
- `request_tool_schema`、`skill_search`、`skill_read` 是协议控制工具，不出现在工具选择器中且始终可用；
  Skill allowlist 决定后两者能看到和读取的实际 Skill。
- 锁定发生在输入校验、附件准备成功之后、真正启动模型运行之前。空消息、准备失败与被拒绝发送不锁定；
  停止、重试、回退与删除消息都不解锁。
- 老会话没有策略字段时维持历史行为，但视作只读的“旧版不受限”会话；不会让带历史内容的旧会话重新变成草稿。
- 配置入口放在 Composer 控制条。桌面为侧边抽屉，窄屏为全屏面板；锁定后同一入口展示只读摘要与
  “按此配置新建对话”。

## 全局约束

- 编排者只写 `.tasks/`、调度、审查与验收；产品和测试代码由执行 agent 修改。
- 当前在 `main`；不得恢复或改写 `stash@{0}`，不得 reset、checkout、批量格式化或修改无关文件。
- 普通源文件与测试文件不超过 300 行。仅强内聚单一状态机可到 500 行，且报告必须说明理由。
- 每个文件只负责一个业务点或抽象；新增 UI 样式放独立 CSS，不继续堆大文件。
- 执行 agent 不得 commit、不得派生子 agent，只写任务声明范围与自己的 report。reviewer 只写 review。
- 禁止真实付费模型、发布、push、上传 artifact 或读取真实 secret。
- 所有运行时判断必须 fail closed；不能只靠 UI 隐藏按钮。

## 任务树

- 100 会话策略 (`group`)
  - [010](010-session-policy-contract.md) 建立持久策略、草稿命令与首条消息锁定 (`leaf`，依赖：无)
- 200 策略消费者 (`group`)
  - [020](020-runtime-enforcement.md) 在工具、Skill 与子代理运行时强制 allowlist (`leaf`，依赖：010)
  - [030](030-conversation-settings-ui.md) 实现草稿编辑器、锁定摘要与复制新对话 (`leaf`，依赖：010)
- 300 收口 (`group`)
  - [040](040-coverage-audit.md) 独立审计跨层覆盖与回归门 (`leaf`，依赖：020、030)
  - [050](050-core-audit-closure.md) 关闭持久化 fail-closed 与核心覆盖缺口 (`leaf`，依赖：040，发现自：040)
  - [060](060-ui-audit-closure.md) 关闭 UI/i18n/异步与全仓 mock 缺口 (`leaf`，依赖：040，发现自：040)
  - [070](070-final-coverage-audit.md) 最终复核覆盖矩阵与全仓机械门 (`leaf`，依赖：050、060，发现自：040)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 会话策略契约 | gpt-5.6-sol | done | 2026-09-08 | 2026-09-08 |
| 020 | 运行时强制过滤 | gpt-5.6-sol | done | 2026-09-08 | 2026-09-08 |
| 030 | 对话配置交互 | gpt-5.6-terra | done | 2026-09-08 | 2026-09-08 |
| 040 | 跨层覆盖审计 | gpt-5.6-sol | done | 2026-09-08 | 2026-09-08 |
| 050 | 核心审计收口 | gpt-5.6-sol | done | 2026-09-08 | 2026-09-08 |
| 060 | UI 审计收口 | gpt-5.6-terra | done | 2026-09-08 | 2026-09-08 |
| 070 | 最终覆盖审计 | gpt-5.6-sol | done | 2026-09-08 | 2026-09-08 |

## 覆盖矩阵

| id | 场景 | 010 | 020 | 030 | 040 |
| --- | --- | --- | --- | --- | --- |
| C-001 | 新对话以当前安全上界为默认草稿 | owner | consume | render | audit |
| C-002 | 草稿可搜索、切换工具与 Skill，含加载/空态 | API | | owner | audit |
| C-003 | 首条有效消息在运行前原子锁定，失败输入不锁 | owner | consume | render | audit |
| C-004 | 锁定后 UI 与命令层均不可修改，回退/停止不解锁 | owner | | owner | audit |
| C-005 | 复制锁定配置创建新草稿 | owner | | owner | audit |
| C-006 | 工具 manifest 与 schema 查询只暴露 allowlist | provide | owner | | audit |
| C-007 | 顶层调用和递归 `callTool` 均拒绝未授权工具 | provide | owner | | audit |
| C-008 | Skill manifest、搜索、读取使用同一 allowlist | provide | owner | | audit |
| C-009 | 子代理工具与 Skill 只能取会话 allowlist 子集 | provide | owner | | audit |
| C-010 | SQLite/IndexedDB/recovery 持久化与旧会话兼容 | owner | | render | audit |
| C-011 | 新注册项不扩张锁定会话，消失项 fail closed | owner | owner | owner | audit |
| C-012 | 全局/工作区开关仍是不可绕过的安全上界 | owner | owner | owner | audit |
| C-013 | 桌面抽屉、窄屏全屏、键盘与焦点可访问性 | | | owner | audit |
| C-014 | 中文与英文文案/catalog 完整 | | | owner | audit |
| C-015 | 独立跨层审计与全仓机械门 | | | | owner |

## 验收总门

1. 新对话未发送消息时可调整工具与 Skill；首条有效消息进入运行前即锁定，刷新与重启后仍锁定。
2. manifest、schema、实际执行、递归工具调用、Skill 搜索/读取与子代理全部使用同一会话策略。
3. 锁定对话不会因安装新插件或新增 Skill 自动获得权限，已消失项目只读显示为不可用。
4. 锁定态可一键复制配置创建新的草稿对话，原对话保持不变。
5. `pnpm test`、`pnpm build`、`pnpm check:state`、`pnpm check:boundaries` 与 `git diff --check` 通过。
6. 新增/大改普通文件不超过 300 行；Lingui extract/compile 后 catalogs 稳定且无 Missing。

## 决策与变更

- 2026-09-08：用户明确“开搞吧”，按直接执行跳过任务树确认点。
- 2026-09-08：选择锁定后持久化具体 allowlist；`loadedTools` 继续只表示 lazy schema LRU，不复用为权限字段。
- 2026-09-08：派发 010，先稳定公共类型、命令与首发锁定契约。
- 2026-09-08：010 执行、独立审查与编排者复验通过；解锁 020/030 并行消费公共契约。
- 2026-09-08：并行派发 020 运行时强制与 030 Web 交互，文件面不重叠。
- 2026-09-08：030 初审发现批量 toggle revision 竞态；顺序化并补真实双项测试后复审 APPROVED，编排者 11 项复跑通过。
- 2026-09-08：020 经两轮 CHANGES_REQUESTED 修复 ToolEpoch/Skill 越权及 resume 漂移；最终复审 APPROVED，相关目录 1216 项全绿。
- 2026-09-08：派发 040 独立覆盖审计，产品代码冻结，只允许报告发现缺口。
- 2026-09-08：040 判定 BLOCKED：Sessions hydrate 可接纳畸形/未来策略、tombstone 英文泄漏、AppShell 全仓回归 5 项失败；发现 050/060，070 负责复核。
- 2026-09-08：并行派发 050 核心安全收口与 060 UI/i18n 收口，文件面不重叠。
- 2026-09-08：050 执行、独立审查与编排者复验通过；恶意策略 fail-closed、持久化往返及生命周期覆盖闭合。
- 2026-09-08：060 首轮复核发现 stale load 污染 generation；身份预检前置并补真实交错测试后复核 APPROVED，解锁 070。
- 2026-09-08：派发 070 最终覆盖审计，冻结产品代码，仅运行全矩阵复核与全仓机械门。
- 2026-09-08：070 最终审计 DONE；C-001 至 C-015、6505 项全仓测试、构建/状态/边界/Lingui/行数门全部通过，040 阻断项完成闭环。

## 审计收口覆盖

| 任务 | 覆盖项 |
| --- | --- |
| 050 | C-003、C-004、C-009、C-010、C-012：持久化/运行时畸形策略 fail-closed 与核心直接回归 |
| 060 | C-002、C-011、C-013、C-014、C-015：异步目录、空态、焦点环、tombstone i18n 与 AppShell mock |
| 070 | C-001 至 C-015 全矩阵、全仓测试/构建/边界与行数终审 |
