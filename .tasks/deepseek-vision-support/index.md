# DeepSeek V4 Flash Vision 支持

创建：2026-08-21

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：功能完成；全树集成收口已通过

## 目标边界

为官方 DeepSeek provider 增加 `deepseek-v4-flash-vision-exp`：一条路径让用户像 Kimi 一样在
Composer 附图并通过 Files API 的 `purpose=user_data` 引用 `file-api-*`；另一条路径增加模型可调用的
`view_image` 工具，用隔离的 DeepSeek 视觉请求读取工作区图片并返回文字观察结果。

官方 Chat 的 `file_id` 内容块不接受有效的 `detail`，Responses 的 `file_id` 也明确忽略它。因此工具的
`detail` 不是伪透传：`low` 为 schema 默认值并在上传前把静态图缩到 512×512 包围盒内，`high` 保留原始
像素。工具说明明确提示 OCR、截图小字、密集图表、细节比较使用 `high`。Composer 附件不暴露这项工具
参数，保留原图上传。

首期继续沿用产品现有静态图片安全策略，只接受 JPEG、PNG、WebP；GIF 虽被上游接受，但本产品当前
附件检测会拒绝动画格式，不能在没有动画解码与像素预算保护时悄悄开放。Files API 上游上限是 64 MiB，
本产品继续使用现有更严格的单文件 20 MiB / 批次 40 MiB 传输预算。

## 全局约束

- 编排者只写本目录、审查和调度；所有产品与测试代码由执行 agent 修改。
- 工作区已有大量用户在途改动和未跟踪文件，禁止 reset、checkout、暂存、提交或覆盖无关改动；范围
  diff 必须按任务 `files` 审查，未跟踪文件用 `git diff --no-index /dev/null <file>` 补充。
- 普通文件不超过 300 行；只有强内聚单一算法/状态机可不超过 500 行且须在报告解释。每个新源文件
  只能承担一句话能说清的职责，禁止 `utils.ts`、`part1`、`xxx2` 假拆分。
- API Key 不进入前端状态、日志、错误、测试快照或文件引用；文件 ID 视为敏感临时引用，不输出到普通
  日志。失败、取消和丢弃路径都尽力 DELETE 已上传文件。
- DeepSeek 路由只开放固定官方 origin 下的 `POST /files`、安全的 `DELETE /files/file-api-*` 与既有
  `POST /chat/completions`；不得开放任意路径、方法或 origin。
- `view_image` 只读显式路径；沿用 workspace root、Auto 外部只读权限、stale/abort 守卫。它不继承
  会话历史、不开放工具、不持久化图片内容，只返回视觉模型的文字结果。
- 用户未授权真实联网、发布、push 或提交；所有上游测试用注入 fetch。执行 agent 不得派子 agent。
- 每项非纯抄录叶完成后都必须独立审查；报告只写 `reports/NNN-report.md`，review 只写对应 review。

## 覆盖矩阵

| id | 表面 / 状态 | 精确入口或路径 | 归属叶子 | 验证证据 | 状态 |
|---|---|---|---|---|---|
| C-001 | 模型目录与能力 | `packages/agent-ai/src/builtinModelDescriptors.ts` | 010 | 36/36 聚焦 + reviewer APPROVED + 编排者复跑 39/39 | done |
| C-002 | Files API 上传与引用 | `packages/agent-ai/src/deepseekFiles.ts`、`deepseekMessages.ts` | 010 | 上传/投影/回滚/清理测试 + reviewer APPROVED | done |
| C-003 | 浏览器/host/preview 路由白名单 | provider route 三个表面 | 020 | 三态 49/49 + reviewer APPROVED + 编排者复跑 49/49 | done |
| C-004 | 工作区图片安全读取 | host command → core workspace capability | 030 | R3 reviewer APPROVED + 编排者复跑 68/68 | done |
| C-005 | Composer 附图会话 | `apps/web/src/modelInput/*` | 040 | 28/28 聚焦 + reviewer APPROVED + 编排者复跑 16/16 | done |
| C-006 | `low` 默认细节 | `view_image` schema → resize → upload | 050、055、060 | schema/512 缩放/静态门禁 + 055 R2 reviewer APPROVED + 编排者复跑 86/86 | done |
| C-007 | `high` 细节 | `view_image` schema → original upload | 050、055、060 | 原字节/固有尺寸/静态门禁 + 055 R2 reviewer APPROVED | done |
| C-008 | 隔离视觉调用 | runtime capability → DeepSeek vision model | 050、055 | 隔离/清理/违规输入零上传 + 055 R2 reviewer APPROVED | done |
| C-009 | 模型可见工具注册 | `tools/standard/src/index.ts` | 060 | 7 域 32 工具，reviewer APPROVED + 编排者复跑 10/10 | done |
| C-010 | 用户文档 | README 模型/工具说明 | 070、055 | 两份 README 官方链接已过；055 恢复静态图片事实一致 | done |
| C-011 | 全链路总门 | 全仓 | 080 | R1 audit/final reviewer APPROVED；编排者复跑 63 文件 542/542 + 全部门 | done |

## 任务树

- 100 Provider 基础 (`group`)
  - [010](010-deepseek-vision-adapter.md) 建立 DeepSeek 视觉适配器 (`leaf`，依赖：无)
  - [020](020-deepseek-files-routes.md) 开放 DeepSeek 文件传输端点 (`leaf`，依赖：无)
- 200 本地图片入口 (`group`)
  - [030](030-workspace-image-read.md) 读取受限工作区图片 (`leaf`，依赖：无)
- 300 产品接入 (`group`)
  - [040](040-deepseek-composer-images.md) 接通 DeepSeek Composer 图片会话 (`leaf`，依赖：010、020)
  - [050](050-vision-tool-runtime.md) 接通视觉工具运行能力 (`leaf`，依赖：010、020、030)
  - [055](055-static-image-policy.md) 统一静态图片门禁 (`leaf`，依赖：050；发现自：080)
  - [060](060-view-image-tool.md) 注册 view_image 工具 (`leaf`，依赖：050)
- 400 收口 (`group`)
  - [070](070-vision-docs.md) 说明 DeepSeek 视觉能力 (`leaf`，依赖：040、060)
  - [080](080-coverage-audit.md) 审核 DeepSeek 视觉覆盖 (`leaf`，依赖：040、055、060、070)

## 状态表

| id | 任务 | model | status | created | done |
|---|---|---|---|---|---|
| 010 | 建立 DeepSeek 视觉适配器 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 020 | 开放 DeepSeek 文件传输端点 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 030 | 读取受限工作区图片 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 040 | 接通 DeepSeek Composer 图片会话 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 050 | 接通视觉工具运行能力 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 055 | 统一静态图片门禁 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 060 | 注册 view_image 工具 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 070 | 说明 DeepSeek 视觉能力 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 080 | 审核 DeepSeek 视觉覆盖 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |

## 就绪集与模型分配

首批并行派发 010、020、030，三者文件面不相交。每一项执行完成后优先用空闲槽做独立审查；010 与
020 通过后派 040，010/020/030 都通过后派 050，随后 060。070 为纯文档叶，080 为只读覆盖审计。
最多三个执行 agent 并行，编排者保留根槽。

## 验收总门

1. `deepseek-v4-flash-vision-exp` 出现在官方 DeepSeek 模型目录，保留 1M 上下文与现有思考能力，并
   具有 JPEG/PNG/WebP 附件能力。
2. Composer 图片通过 `POST /files` + `purpose=user_data` 上传，聊天消息使用
   `{type:'file', file_id:'file-api-*'}`；失败、移除和会话丢弃均尽力清理。
3. `view_image({path})` 等价于 `detail:'low'`，上传前尺寸位于 512×512 包围盒内；
   `view_image({path,detail:'high'})` 保留原始像素。OCR、小字截图和密集图表的使用提示可被模型看到。
4. 视觉工具使用固定 `deepseek-v4-flash-vision-exp`、空历史、无 tools 的隔离请求，尊重取消与 workspace
   路径边界；无能力的宿主返回明确错误而非静默成功。
5. `pnpm exec tsc -b`、`pnpm check:state`、`pnpm check:boundaries`、相关 Vitest、构建和
   `git diff --check` 均通过，存量 Kimi 图片流程不回归。

## 遗留与发现

- GIF/动画图片支持延期：上游虽支持 GIF，但现有客户端的动画检测与低细节缩放无法保持动画语义；需
  独立设计帧数、像素与解码资源预算。
- 本轮不做 DeepSeek Responses API 迁移；Chat Completions 已提供 Files API 引用形状，迁移会扩大
  流式协议与工具调用范围。
- Files API 支持永久文件，但本产品默认把上传视为会话临时资源并尽力删除，避免远端留存失控。

## 决策与变更

- 裁决: `detail` 在客户端预处理 — file_id 路径不会应用服务端 detail；错了的代价是低档缩放结果与
  上游未来实现不完全一致，但至少参数今天具有可测试的真实语义。
- 裁决: `view_image` 返回隔离视觉调用的文字观察 — 现有 ToolResult 不承载二进制图片块；错了的代价
  是主模型看到的是视觉模型解释而非原始像素，但避免扩大整个工具结果协议。
- 裁决: 继续 20 MiB 单文件上限 — 复用现有受审 transport 预算；错了的代价是 DeepSeek 官方允许的
  20–64 MiB 文件暂不可用。
- 2026-08-21：用户以“开搞”授权直接运行，跳过二次确认。
- 2026-08-21：首批 010、020、030 并行派发；三者分别限定 agent-ai、路由白名单、工作区图片读取。
- 裁决: 030 纳入 host 命令名、参数联合和 invoke 契约 — 它们是新增受限图片命令必需的静态注册面；
  错了的代价是执行者要多迁移四个窄文件，但不纳入会造成命令实现存在却无法安全调用。
- 2026-08-21：020 独立审查通过；编排者复跑 browser/host/preview 49 个路由测试全绿，C-003 完成。
- 2026-08-21：010 独立审查通过；编排者复跑 adapter 39 个测试全绿，C-001/C-002 完成，040 解锁。
- 裁决: 040 的历史兼容改由 `packages/agent-ai/src/historyImageCompatibility.ts` 承担 — 它是持久化
  provider 引用投影的唯一 owner，app 仅消费；错了的代价是任务跨两个包，但把规则复制到 UI 会造成漂移。
- 2026-08-21：030 首轮审查拒绝 symlink check-then-open 竞态与错误路径泄漏；原执行者进入 R1，
  同轮补 core 对 host payload 的大小/魔数复核。050 继续等待 030 复审。
- 2026-08-21：040 独立审查通过；编排者复跑 Composer 上传/处置/历史投影 16 项全绿，C-005 完成。
- 2026-08-21：030 R1 复审拒绝父目录二次切换反例；R2 改为从已打开 handle 获取最终路径后做
  confinement，Linux/macOS 分别使用 proc fd / 固定参数 lsof，其余或能力缺失平台 fail-closed。
- 2026-08-21：030 R2 关闭路径竞态，但发现 FIFO 可在校验前阻塞 open；达到两轮修复上限，R3
  升档由新 Sol/ultra 接手最小修复。050 仍未解锁。
- 2026-08-21：030 R3 最终审查通过；编排者复跑 57 项图片安全与 11 项接线测试共 68/68 全绿，
  C-004 完成，050 解锁。
- 2026-08-21：050 首轮审查拒绝 low 编码 MIME/上传元数据漂移与 host 读图错误路径泄漏；原执行者
  进入 R1，060 继续等待。
- 2026-08-21：050 R1 独立复审通过；编排者复跑 runtime/core/main 20 项全绿，C-008 完成，
  C-006/C-007 等 060 的 schema/透传闭环。
- 2026-08-21：060 独立审查通过；编排者复跑工具与标准目录 10 项全绿，C-006/C-007/C-009 完成，
  070 解锁。
- 裁决: 070 只同步仓库真实存在的 `README.md` 与 `README.zh-CN.md` — 基线也没有繁中/日文 README；
  错了的代价是本轮不增加新语种，但避免为一个功能创建两份残缺翻译文档。
- 2026-08-21：070 审查后编排者验收发现官方链接缺 `/zh-cn` 路径段；文档任务进入最小 R1，C-010
  暂不标完成。
- 2026-08-21：070 R1 复审通过；编排者确认两份 README 各 2 个精确 zh-cn 官方链接，C-010 完成，
  080 覆盖审计解锁。
- 2026-08-21：080 只读审计的机械总门全绿，但最终 Sol 审查 REJECTED：`view_image` 未复用静态图片
  动画/尺寸策略，APNG、animated WebP 与超尺寸 high 可在上传前漏过。新增 055，C-006/C-007/C-008/
  C-011 回到 in_progress；C-010 文案待实现恢复 static 真实性。
- 裁决: 055 下沉纯容器策略供 Composer 与 vision 共享 — 复制 UI 动画检测会漂移，vision 反向依赖 UI
  又破坏层次；错了的代价是需要迁移现有 UI 测试，但安全 owner 唯一。
- 2026-08-21：055 首轮审查拒绝容器 parser 的 JPEG 终止结构、PNG CRC、WebP 必需头字段漏验；
  原执行者进入 R1，按格式职责拆 parser 并补精确 malformed 零上传反例。
- 2026-08-21：055 R1 关闭原五组 parser 反例；复审仍拒绝 JPEG SOF sampling/Tq 与 indexed PNG
  PLTE/bit-depth 两项固定字段一致性，原执行者进入 R2。
- 2026-08-21：055 R2 独立复审通过；编排者复跑静态门禁、Composer 与 viewer 7 文件 86/86 项及
  app TypeScript 全绿，C-006/C-007/C-008/C-010 完成，080 重新进入全量覆盖审计。
- 2026-08-21：080 R1 全量审计与最终 Sol R1 审查均 APPROVED，旧 REJECTED 明确 superseded；编排者
  复跑全仓类型、state、boundaries、63 文件 542/542 项测试、生产 build 与 whole-worktree diff-check
  全绿。C-011 完成，任务树收口。
- 2026-08-31：全量 `pnpm test` 发现旧 Composer 图片测试仍构造只有签名的非法 PNG；产品静态门禁保持，
  夹具修复交由 `integration-closure/010`。用户授权审查后分批 commit。
- 2026-08-31：`integration-closure/050` 全量门与最终独立审查 APPROVED，跨树收口完成。
