# 多模型连接中心

创建：2026-08-21

基线：`c7befb48ea8c38a91d10c58097cb1206fbef8cc1`

状态：功能完成；全树集成收口已通过

## 目标边界

把现有「一条第三方连接只能绑定一个模型」改为下列可理解的模型中心：

```text
来源预设（官方 / 云端服务商 / 自部署 / 本地）
  → 连接（名称、OpenAI 兼容 Base URL、写入式 Key）
    → 模型（发现到的或手动添加的多个模型 ID）
      → 会话（一次新对话或未来新对话默认）
```

首期只接 `openai-compatible`：自部署的 vLLM、SGLang、LM Studio、Ollama 的 OpenAI 兼容模式及
第三方 DeepSeek 网关均可进入。官方 DeepSeek、GLM、Kimi 继续走既有官方 adapter，不能被第三方
URL 冒充。首期不新增 Anthropic Messages、Gemini、OpenAI Responses 或任意未实现 adapter。

运行时身份绝不从显示名、模型 ID、preset category 或 manifest 推断：`vendor: 'deepseek'`、
`'glm'`、`'kimi'` 只代表各自官方 adapter；任何 user profile 一律是
`vendor: 'openai-compat'` 加 `vendorSettings.connectionId`。因此名字为 “DeepSeek-R1”、地址为第三方
网关的 profile 只能使用标准兼容请求形状，绝不会获得或污染官方 DeepSeek 的 `user_id`、
`reasoning_effort` 投影、模型能力表或官方 origin。

「导入开源配置」实现为本产品验证过的**非秘密 JSON manifest**导入；不嵌入、不依赖、不复制
Cherry Studio、Chatbox 或 LobeChat 的代码。导入永远不含 API Key，用户仍在本机 server 表单内填写。

## 全局约束

- 编排者只写本目录、审查和调度；所有产品与测试代码由执行 agent 修改。
- 工作区已有用户在途改动，禁止 reset、checkout、暂存、提交、覆盖无关文件；任务 diff 一律按各叶
  `files` 和其 `base` 审查。
- 每个普通源文件只做一件事且不超过 300 行；业务、表单、加载及错误状态只使用 Einfach，不新增
  React 本地状态或其他状态库。
- API Key 仅可从浏览器密码草稿写入本机 host 的 credential section；不得出现在 list/read/probe
  响应、transport target、日志、错误、测试快照、导入 manifest 或前端持久化状态。
- profile 请求仍只把 `connectionId` 穿过 browser/agent transport；Base URL 与 Key 仅由 host 从同一
  受锁快照绑定，保留同 URL 不同 profile 的 Key 隔离和 fail-closed 路由。
- Base URL 必须继续使用既有 `requireOpenAiCompatBaseUrl` 规则：HTTPS，或仅回环 HTTP；无 query、
  fragment、username、password。探测不得绕过此验证。
- 用户未明确授权不得联网打真实上游、发布、push、上传 artifact 或提交。测试以注入 fetch / 本地
  harness 模拟。执行 agent 不得派子 agent、不得 commit。
- 执行报告仅写 `reports/NNN-report.md`；独立审查仅写 `reports/NNN-review.md`。范围外发现必须写报告，
  不得顺手修。

## 任务树

- 100 Host 数据与探测 (`group`)
  - [010](010-multimodel-profile-schema.md) 迁移多模型连接存储 (`leaf`，依赖：无)
  - [020](020-connection-model-probe.md) 探测兼容端点模型 (`leaf`，依赖：010)
- 150 厂商优化保护 (`group`)
  - [015](015-official-adapter-separation.md) 固化厂商 adapter 身份 (`leaf`，依赖：无)
- 200 浏览器控制面 (`group`)
  - [030](030-profile-model-state.md) 管理连接模型草稿 (`leaf`，依赖：010、020)
  - [035](035-reset-probe-context.md) 清理探测编辑上下文 (`leaf`，依赖：030)
  - [040](040-connection-preset-registry.md) 提供连接来源预设 (`leaf`，依赖：010)
  - [050](050-profile-manifest-import.md) 解析非秘密连接清单 (`leaf`，依赖：010)
- 300 设置体验与验收 (`group`)
  - [060](060-model-center-ui.md) 呈现多模型连接中心 (`leaf`，依赖：035、040、050)
  - [065](065-migrate-profile-test-fixtures.md) 迁移连接契约测试夹具 (`leaf`，依赖：030)
  - [070](070-model-center-verification.md) 审核模型中心边界 (`leaf`，依赖：020、060)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 迁移多模型连接存储 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 015 | 固化厂商 adapter 身份 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 020 | 探测兼容端点模型 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 030 | 管理连接模型草稿 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 035 | 清理探测编辑上下文 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 040 | 提供连接来源预设 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 050 | 解析非秘密连接清单 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 060 | 呈现多模型连接中心 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |
| 065 | 迁移连接契约测试夹具 | gpt-5.6-terra | done | 2026-08-21 | 2026-08-21 |
| 070 | 审核模型中心边界 | gpt-5.6-sol | done | 2026-08-21 | 2026-08-21 |

## 就绪集与模型分配

确认后并行派 010（存储与安全迁移，Sol）与 015（官方 adapter 保护，Sol）；两者文件面不相交。
010 审查通过后并行派 020（host 探测，Sol）、040（纯预设数据，Terra）、050（纯导入解析，Terra）；
三者文件面互不相交。随后 030（Einfach 控制面，Terra），最后派 060（完整交互，Sol）和 070
（跨层安全终审，Sol）。最多三个执行 agent 并行，始终预留一槽给独立 reviewer。

## 验收总门

1. 一个 profile 可保存至少一个模型并可保留多个模型；旧的单一 `model` 持久化记录迁移为一个
   `source: 'manual'` 模型，旧会话仍用原模型 ID。
2. 兼容端点探测只请求验证后的 `${baseUrl}/models`，仅返回受限模型元数据；Key 不出 host，探测失败
   不写配置。
3. 设置可从来源预设、新建、自部署或本地连接开始；测试后可勾选发现模型，也可手动添加模型；一条
   连接上的任一模型均可新建会话或设为未来默认。
4. 公开 manifest 只能导入来源、地址和模型，不能导入 Key；JSON 中任何多余秘密字段必须被拒绝而非
   忽略。
5. `pnpm exec tsc -b`、`pnpm check:state`、`pnpm check:boundaries`、相关 Vitest 及 `git diff --check`
   均通过；静态部署继续隐藏 profile 管理，官方 provider 与 legacy 默认连接不回归。
6. 即使 profile 标签或模型 ID 包含 DeepSeek、GLM、Kimi，profile 请求仍精确走
   `openai-compat` 适配器与 profile Base URL；官方会话继续走各家专属 adapter、官方 origin 及私有
   请求投影。

## 遗留与发现

- 本轮不做在线第三方 manifest 商店、自动下载 GitHub 配置、图标远程加载或价格比较；它们会扩大
  供应链、网络与信任边界。
- Anthropic、Gemini、Responses 连接要先新增受限 transport adapter 与 host 路由，再在独立树中开放
  UI；不能把地址字段改名后当作支持。
- URL 探测的本机回环例外必须保留，以支持本机 Ollama/LM Studio；内网 HTTP 不扩大白名单。

## 决策与变更

- 裁决: 首期按「连接下多个模型」建模 — 这消除第三方 DeepSeek 与自部署每选一个模型就新建一条
  连接的核心摩擦；错了的代价是后续若需要每模型独立 Key，必须增加模型级 credential 引用。
- 裁决: 保持 `openai-compatible` 单协议 — 当前 agent 与 host 已有闭合且经安全测试的该协议链；错了的
  代价是非兼容厂商暂时不可由自定义连接接入。
- 裁决: 厂商优化由不可变 `vendor` identity 决定 — 不能用字符串猜服务商，否则第三方同名模型会偷走
  官方 adapter 或官方请求字段；错了的代价是一些兼容网关不能自动取得官方特性，需未来由明确的受审
  compatibility profile 单独开放。
- 裁决: 自研 manifest 格式而不嵌入开源客户端 — Cherry Studio 的 AGPL-3.0、Chatbox 的 GPLv3 与本
  项目授权/架构并不天然兼容；错了的代价是不能直接复用其配置生态，需在格式上提供清晰导入说明。
- 2026-08-21：用户确认开工；010 与 015 已并行派发。
- 2026-08-21：010、015 执行完成，进入独立审查。010 报告发现 `connectionProfileCommandArgs.ts`
  仍是旧单模型契约；审查后按结论决定是否列为 R1。
- 裁决: 010、015 的全仓 `tsc -b` 改为 060/070 总门 — 多模型公开类型必须由 030、060 的下游
  消费方共同迁移，前置叶在共享 worktree 中不可能单独闭合全仓类型；错了的代价是中间态短暂不通过
  root 类型检查，故 060 和 070 均保留全仓总门，且下游未解锁前不称 010/015 完成。
- 2026-08-21：010 首轮审查拒绝静态 save 参数契约漏迁移；015 首轮审查拒绝 DeepSeek
  `reasoning_effort` 取值域未固化。两项均已原执行者 R1 限定修复。
- 2026-08-21：010、015 R1 聚焦验收通过，进入独立复审。裁决: 对未跟踪任务文件的审查使用
  `git diff --no-index /dev/null <file>` 生成等价范围 diff — worktree 尚未授权暂存/提交，普通
  `git diff <base>` 看不到新增文件；错了的代价是要逐文件明确生成审查输入，避免把未跟踪实现
  当成空 diff。
- 2026-08-21：010、015 R1 均经独立复审通过并完成；020、040、050 已并行派发。
- 裁决: 040、050 与 010、015 同样不在中间态执行全 app `tsc` — 它们共享 010 的 public type，
  030/060 尚未迁移旧消费者；错了的代价是纯数据叶无法单独证明全 app 类型，故必须在 060 及 070
  重跑总门。040、050 的本地 Vitest 与 diff 门保持不变。
- 2026-08-21：040、050 执行完成，等待独立审查；020 发现 probe 的 `NodeHostCommandArgs` 静态联合
  需要同步，已纳入它的 files 边界。
- 2026-08-21：040、050 经独立审查通过并完成。050 审查有 Minor：根级未知字段和
  `connection.id` 缺少显式回归 case；精确白名单实现已覆盖该安全属性，不进修复循环，留至终审复核。
- 2026-08-21：020 执行完成，聚焦 host/web adapter 验收通过，进入独立审查。
- 2026-08-21：020 独立审查通过并完成。Minor 留至终审：单独 3xx 响应断言，及 1,000 模型/200-byte
  ID 边界 case；现有实现与其它安全覆盖足以通过本叶。
- 2026-08-21：030 执行完成，定向验收通过，进入独立审查。
- 2026-08-21：030 首轮审查拒绝：模型数组只按长度校验，空白 model ID 可保存。R1 限定修复这一
  Important；probe 状态跨编辑器残留为 Minor，记入终审，不扩本轮范围。
- 2026-08-21：030 R1 已完成，等待独立复审空白 model ID 的校验和回归。
- 裁决: 将 030 审查的 probe 状态残留 Minor 拆为 035 — 旧连接探测结果若出现在新编辑器会诱导错误
  模型选择，值得在 UI 接入前清除；错了的代价是多一个小任务和一次审查，但避免 060 承担状态层职责。
- 2026-08-21：030 R1 独立复审通过并完成；035 已从其 Minor 发现创建并派发，060 改依赖 035。
- 2026-08-21：035 执行完成，聚焦验收通过，进入独立审查。
- 2026-08-21：035 首轮审查拒绝：异步 probe 可在上下文失效后回写，且 settings close 缺少直接断言。
  R1 限定加入代次失效和关闭入口测试；060 继续等待 035 复审。
- 2026-08-21：035 R1 完成，聚焦状态及真实 close 入口测试通过，等待独立复审。
- 2026-08-21：035 R1 独立复审通过并完成；060 已派发。
- 2026-08-21：060 执行完成，组件/状态验收通过，进入独立 UI 审查。全仓 `tsc` 剩三处范围外旧
  单模型测试夹具，审查后拆出独立小卡处理。
- 裁决: 060 范围外的三处旧单模型 test fixture 由 065 单独迁移 — 这保持 UI 组装与契约 fixture
  各自单一职责；错了的代价是 060 要在 065 后由原执行者复跑总门，不能立刻标 done。
- 2026-08-21：060 首轮审查确认无 UI 范围内 Important 产品缺陷，但因全仓 `tsc` 未闭合拒绝；065
  已从该发现创建并派发。FileReader 绑定层覆盖与视觉验收为 Minor，交给 070 终审。
- 2026-08-21：065 执行完成，定向测试和全仓 tsc 通过，进入独立审查。
- 2026-08-21：065 独立审查通过并完成；060 已交原执行者 R1，仅复跑其验收总门。
- 2026-08-21：060 R1 的 UI、state、全仓 tsc 及 diff 门均通过，等待独立复审。
- 2026-08-21：060 R1 独立复审通过并完成；070 已派发，并显式消化此前所有 Minor。
- 2026-08-21：070 执行完成，87 个跨层测试和最终类型/状态/边界/Vite/diff 门通过，进入独立复审。
- 2026-08-21：070 独立复审通过并完成；编排者复跑 9 文件 87 测试及完整类型/状态/边界/Vite/diff
  总门，全部通过。任务树收口。
- 2026-08-31：全量测试发现 cancel registrar 的精确 key 清单漏记已终审 probe，测试同步交由
  `integration-closure/020`。用户授权审查后分批 commit。
- 2026-08-31：`integration-closure/050` 全量门与最终独立审查 APPROVED，跨树收口完成。
