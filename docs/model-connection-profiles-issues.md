# 模型连接配置 Issue

状态：执行中
创建日期：2026-08-21
协调者：Codex（只负责架构、任务树、验收与交付）

## 目标与边界

将设置页从“厂商 API Key 清单”扩展为可管理的模型连接。官方 DeepSeek、GLM、Kimi
继续走各自验证过的 adapter；其它厂商托管的 DeepSeek、聚合平台与自建网关必须显式标为
“第三方 / OpenAI 兼容”，不能伪装成 DeepSeek 官方连接。

首期只支持标准 `POST <baseUrl>/chat/completions`、Bearer API Key 与手填模型 ID。每条
第三方连接有独立名称、端点、模型、密钥与稳定 ID；默认模型只影响后续新建对话，已有会话
保持自己的连接。当前运行的会话不允许热切换。

非目标：厂商私有请求头、任意请求路径、自动拉取 `/models`、自动猜测模型能力、静态部署的
第三方 BYOK、将第三方 DeepSeek 接入官方 DeepSeek adapter。

## 冻结契约

1. 第三方连接的公开元数据是 `{ id, label, kind: 'openai-compatible', baseUrl, model,
   credentialConfigured }`；`id` 使用受控 ASCII 标识。API Key 只可短暂存在于 write-only 的
   password 草稿，绝不属于返回体、公开 profile、持久化设置、会话或模型 wire target。
2. 元数据存入 host 配置的独立 `modelConnections` 段；Key 仍只存 `modelCredentials` 段，键名为
   `openai-compat:profile:<id>`。读写 Key 的唯一出口仍是 host-node 的凭据层。
3. 会话使用 `{ vendor: 'openai-compat', model, vendorSettings: { connectionId } }`。wire target
   可携带 `connectionId`，但不能携带 URL、header 或 Key；host 通过 ID 查登记值并 fail closed。
4. 旧的单一 `openai-compat:default` 接入点保持可用；没有 `connectionId` 的历史会话仍使用它。
   新连接绝不自动覆盖或迁移旧端点。
5. 第三方连接只在 `server` 宿主可创建及使用。静态 BYOK 继续只允许官方厂商，UI 给出原因。
6. Host 命令名固定为 `model_connection_profile_list`、`_read`、`_save`、`_delete`；save 输入为
   `{ id, label, baseUrl, model, apiKey? }`，read/delete 只接 `{ id }`。所有响应只含公开元数据。
   list 返回按 ID 排序的数组，read 返回 profile 或 `null`，save 返回已保存 profile，delete 返回
   `{ deleted }` 并幂等撤销孤儿 Key；`credentialConfigured` 每次由 Key 状态推导，绝不落盘。

## 任务树

```text
MODEL-CONNECTIONS  多模型连接配置
├─ MC-00  契约与迁移边界
│  └─ MC-00A  冻结 profile、credential、legacy 的协议（DONE，本文件）
├─ MC-10  连接存储
│  └─ MC-10A  持久化第三方连接 profile
│  └─ MC-10B  原子保存 profile 元数据与凭据
│  └─ MC-10C  收窄多段事务的段可见性
│  └─ MC-10D  同快照解析 profile 端点与凭据
├─ MC-20  设置状态
│  └─ MC-20A  管理 profile 的前端命令状态
│  └─ MC-20B  保存 profile 编辑器的显示状态
│  └─ MC-20C  关闭设置时撤销 password 草稿
├─ MC-30  设置交互
│  └─ MC-30A  渲染第三方连接折叠卡
│  └─ MC-30B  渲染受控连接编辑器
│  └─ MC-30C  分离连接展示与编辑职责
│  └─ MC-30D  增加默认连接的展示动作
├─ MC-40  受限传输
│  └─ MC-40A  按 connectionId 解析兼容端点
│  └─ MC-40B  固定 legacy 连接的 vendor 身份
│  └─ MC-40C  限制 legacy 身份标记的传输边界
├─ MC-50  默认模型
│  └─ MC-50A  保存新对话的默认连接
├─ MC-55  宿主装配
│  └─ MC-55A  装配 profile host 与安全默认
├─ MC-60  功能接线
│  └─ MC-60A  合并官方卡与第三方连接面板
├─ MC-70  验证
│  ├─ MC-70A  运行聚焦的跨层回归
│  └─ MC-70B  独立安全审查
└─ MC-80  交付
   └─ MC-80A  回填账本与验收记录
```

## 叶子任务与模型分配

| ID | Wave | Owner model | 独占文件 / 模块 | 依赖 | 完成判据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| MC-10A | B1 | gpt-5.6-sol（high） | `packages/host-node/src/model/connectionProfile*`、`connectionProfileCommands*`、本域命令登记 | MC-00A | profile CRUD 不回显 Key；Key 与元数据分段；坏配置、非法 ID/URL、缺 Key 均受控失败 | done（27 个聚焦、181 个模型/登记测试、host-node build、TypeScript、`git diff --check`） |
| MC-10B | B4 | gpt-5.6-sol（high） | host-node 配置事务、`connectionProfileCommands*` 与故障测试 | MC-10A | profile 元数据与 profile Key 的 save/delete 是同一配置事务；任何落盘故障不产生新 Key→旧 origin、孤儿 Key 或部分删除 | done（agent host config/model 23 文件 231/231、host-node build、TypeScript、`git diff --check`；待根复跑与 MC-70B 复审） |
| MC-10C | B5 | gpt-5.6-sol（high） | `webAgentConfigStore` 多段快照与边界测试 | MC-10B | 多段事务只能读取/改写显式段的深隔离快照；不得经浅引用触碰 `modelCredentials` 等未声明段 | done（agent config/profile 7 文件 65/65、host-node build、TypeScript、`git diff --check`；根复跑 3 文件 30/30，复审待总验） |
| MC-10D | B6 | gpt-5.6-sol（high） | profile forward binding、credential/profile snapshot 与竞态测试 | MC-10C、MC-40C | profile 请求在一次受锁快照内同时解析 ID→origin 与 ID→Key；并发 save 不得让旧 origin 配新 Key | done（agent host model 19 文件 185/185；根复跑 4 文件 35/35、host-node build、TypeScript、`git diff --check`；待最终复审） |
| MC-20A | B1 | gpt-5.6-terra（medium） | `apps/web/src/settings/modelConnectionProfile*`、对应测试 | MC-00A | hydrate/save/delete 只保留公开元数据与 password draft；失败保留草稿；不改既有凭据模块 | done（聚焦 Vitest 5/5、TypeScript、`git diff --check`；各文件 ≤170 行） |
| MC-20B | B2 | gpt-5.6-terra（medium） | `modelConnectionProfileState.ts`、`modelConnectionProfileCommands.ts` 与同名测试 | MC-20A | 编辑器显示状态只进 Einfach；新建/编辑/取消不会残留 password draft | done（生命周期用例及 B7 设置/UI 回归通过；TypeScript、Vite build 已在最终验收通过） |
| MC-20C | B5 | gpt-5.6-terra（medium） | settings center close 命令、profile state/生命周期测试 | MC-20B、MC-60A | 用户关闭/Esc/遮罩关闭设置时清空 write-only password 草稿并关闭 profile editor；保存失败重试期间不清空 | done（agent 聚焦 13 个测试、TypeScript、`git diff --check`；根复跑 3 文件 23/23，复审待后续总验） |
| MC-30A | B1 | gpt-5.6-luna（medium） | 新增 `apps/web/src/agentNew/ui/ModelConnectionProfilesPanel*` 与专属 CSS | MC-00A | 语义化折叠卡、第三方标签、表单 a11y；仅依赖稳定 UI props，不接脏文件 | done（聚焦 Vitest 2/2、TypeScript、`git diff --check`；167/75/26 行） |
| MC-30B | B2 | gpt-5.6-luna（medium） | 新增 `ModelConnectionProfileEditor*` 与专属 CSS | MC-20B | 新建/编辑均可输入 ID、名称、端点、模型与 write-only Key；无局部产品状态 | done（编辑器/折叠卡 4 个聚焦测试、独立 TypeScript、`git diff --check`；共享 Vite 仍受外部 Lingui 缺包阻断） |
| MC-30C | B2 | gpt-5.6-luna（medium） | `ModelConnectionProfilesPanel*` 与专属 CSS | MC-30B | 折叠卡只显示公开元数据；唯一可编辑表单是 editor，避免两处表单语义分叉 | done（2 个聚焦组件测试、独立 TypeScript、`git diff --check`；共享 Vite 仍受外部 Lingui 缺包阻断） |
| MC-30D | B3 | gpt-5.6-luna（medium） | `ModelConnectionProfilesPanel*` 与专属 CSS | MC-30C、MC-50A | 每个 profile 有独立“设为新对话默认”展示动作；仍是无状态组件，不能启动对话或直接写设置 | done（组件聚焦 2/2、`git diff --check`；130/75/37 行） |
| MC-40A | B2 | gpt-5.6-sol（high） | `providerTransport`、web `modelTransport`、host-node `model/providerRoute` 与其聚焦测试 | MC-10A、MC-20A | `connectionId` 是唯一动态路由标识；未知/删除 profile 绝不请求；历史无 ID 路径不变 | done（根复跑 5 文件 44/44；agent 聚焦 18 文件 123/123、ai/host build、`git diff --check`） |
| MC-40B | B4 | gpt-5.6-sol（high） | legacy `openai-compat` adapter/web 路由与回归测试 | MC-40A | 无 ID legacy 会话始终产生 `openai-compat` target 并使用 legacy Key；不能因 endpoint 撞上官方 origin 而静默变成 DeepSeek/GLM/Kimi | done（agent 34 文件 245/245；ai build、web TypeScript、边界检查、`git diff --check`；待根复跑与 MC-70B 复审） |
| MC-40C | B5 | gpt-5.6-sol（high） | agent-ai local marker carrier、web provider fetch 与跨宿主测试 | MC-40B | legacy 身份仅能在 closed provider transport 内被消费；CLI/直连 fetch 永不发送内部 marker 到上游 | done（agent 10 文件 69/69、ai build、TypeScript、`git diff --check`；待根复跑与总复审） |
| MC-50A | B2 | gpt-5.6-terra（high） | 设置持久化、默认模型装配、单测 | MC-20A | 默认只作用新会话；删除默认 profile 有可见降级；会话持久化不含 Key/URL | done（设置聚焦测试 30/30、TypeScript、`git diff --check`；schema v4 从 v1–v3 迁移） |
| MC-55A | B3 | gpt-5.6-sol（high） | profile host 工厂、`main.tsx` 与聚焦测试 | MC-40A、MC-50A | 只在 server 装配 profile host；hydrate 后运行时默认必须指向仍存在的 profile；静态态只回退内置默认、不抹掉用户偏好 | done（agent 聚焦 10 文件 52/52；根复跑 6 文件 26/26、TypeScript、`git diff --check`） |
| MC-60A | B4 | gpt-5.6-sol（high） | `ModelCredentialPanel`、`SettingsDialog`、模型页集成测试 | MC-30D、MC-40A、MC-50A、MC-55A | 官方/第三方分组折叠；默认卡自动展开；“用此连接新建对话”正确；保留现有未提交改动 | done（agent 聚焦 4 文件 18/18；根复跑 4 文件 19/19、TypeScript、Vite build、状态/边界检查、`git diff --check`） |
| MC-70A | B7 | gpt-5.6-terra（medium） | 只读验证；必要时新建独立集成测试 | MC-10D、MC-20C、MC-40C | 聚焦测试、类型检查、构建、`git diff --check` 的实际输出 | done（B7 14 文件 95/95；TypeScript、状态/边界检查、Vite build、`git diff --check`） |
| MC-70B | B7 | gpt-5.6-sol（high，非实现 owner） | 只读审查 | MC-10D、MC-20C、MC-40C | 无 Key/URL 绕过、无开放代理、无静默 vendor 混淆；结论写回本文件 | done（第四轮 PASS；17 文件 124/124；无遗留安全项） |
| MC-80A | B8 | gpt-5.6-luna（medium） | 本文档及必要用户说明 | MC-70A、MC-70B | 只记录已验证行为与实测命令；文档检查通过 | done（本节验收记录） |

MC-50A 的偏好会先安全保存为无秘密的 ID 与模型名；MC-60A 必须按 profile host 的 `available`
状态应用它，静态宿主一律恢复内置默认，不能因浏览器里残留的偏好而尝试第三方连接。MC-10B
要求密钥段与 profile 元数据段虽逻辑隔离、但任意单次 profile 写入或删除必须同一份配置快照原子提交。

## 并发与脏工作区护栏

并发上限为三个实现 agent。B1 的三张卡文件完全不重叠；B2 只能在 B1 的接口与测试冻结后
启动；MC-60A 是唯一允许编辑当前脏文件 `ModelCredentialPanel.tsx`、`SettingsCenter.test.tsx`
及相关设置接线的叶子，必须逐块保留既有改动。任何发现新重叠文件的任务立即停下并更新本树。

开始时工作区已有用户改动，包括模型凭据卡、模型面板、设置测试、host 分流和 core history。
这些改动不属于本 Issue：不暂存、不重写、不恢复。所有 agent 均禁止提交和暂存。

## 验收清单

- 同时保存两个第三方 DeepSeek profile 时，端点与 Key 严格按 profile 隔离。
- profile 在 UI 中显示“第三方 / OpenAI 兼容”，官方 DeepSeek 仍显示“官方直连”。
- 通过 wire 伪造 URL、未知 ID、删除后的 ID 与多余 target 字段都被拒绝，且不会发生上游请求。
- 保存、列表、trace、错误和测试快照均不出现 API Key；删除 profile 同时撤销其 Key。
- 默认连接只用于后续 `newSession()`；历史会话的 `connectionId` 可持久化且不带 URL/Key。
- 新增/大改源文件均满足 300 行限制；存量超限文件只作最小集成改动。

## 最终验收记录

- 第三方连接通过受控 ID 路由；会话与 wire target 均不含 URL、header 或 API Key。ID 对应的
  endpoint 与 Key 在保存、删除、读取转发三个阶段均由同一原子配置快照绑定。
- 官方 DeepSeek、GLM、Kimi 显示为独立的“官方直连”折叠项；第三方/自建/托管 DeepSeek 显示为
  “第三方 / OpenAI 兼容”，旧版单连接独立标为迁移项。静态宿主不暴露第三方连接。
- 默认连接仅影响后续 `newSession()`；缺失 profile、静态宿主、删除或加载失败均回退内置默认。
  关闭设置会清空未保存 password 草稿，失败保存打开期间仍可重试。
- 最终跨层回归：14 个测试文件、95 个测试通过；独立安全复审：17 个测试文件、124 个测试通过，
  无遗留项。`pnpm exec tsc -b --pretty false`、`pnpm check:state`、`pnpm check:boundaries`、
  `pnpm exec vite build --config vite.config.ts` 与 `git diff --check` 均通过。Vite 仅报告既有
  dynamic-import 与大 chunk 警告。
