# 040 独立审查

## 结论

**APPROVE**

未发现 Blocker、High、Medium 或 Low finding。实现满足 040 叶对 registry 全量投影、profile 多模型、
credential availability、连接身份、稳定 key、缺失当前模型、安全字段边界、稳定顺序及后续 UI 分组
本地化的契约。

## Findings

- Blocker：无。
- High：无。
- Medium：无。
- Low：无。

## 审查证据

### Registry 全量与稳定顺序

- `composerModelOptions.ts:90-93` 每次直接枚举 `defaultProviderRegistry.listModels()`，没有维护第二份内置
  白名单，也没有只投影原型中的四个模型；随后才追加 profile 模型。
- `providerRegistry.ts:134-146` 按 adapter 注册顺序及 descriptor 声明顺序枚举，并冻结返回数组；010 的
  完整 catalog 测试固定了 17 个内置模型及顺序。040 的测试再将全部输出与同一次 registry 枚举逐项比对。
- `composerModelOptions.ts:90-97` 只依赖 registry 与传入 profile 数组的既有顺序，不使用随机值、时间、对象
  hash 或 locale 排序；重复相同投影得到相同顺序。`composerModelOptions.test.ts:88-101` 覆盖重复投影及
  profile 输入顺序保持。

### Profile 多模型、availability 与精确 identity

- `composerModelOptions.ts:47-59` 对 credential 未配置的 profile 返回空选项；availability 只参与这一项
  inclusion 判断，没有写入结果或改变 identity。可用 profile 的每个 `models[]` 元素各产生一个选项。
- profile identity 固定为 `{ vendor: 'openai-compat', model, vendorSettings: { connectionId } }`，没有按
  model 名称猜官方厂商；同一 profile 的多个模型共享连接 ID，但保留各自模型 ID。
- `composerModelOptions.test.ts:39-55,73-85` 同时覆盖一条 profile 的两个模型、credential 未配置时不列出，
  以及 unavailable profile 中的当前会话模型仍作为 current 项保留。
- host 契约保证真实 profile ID 唯一，且 `connectionProfile.ts:89-93` 拒绝同一 profile 内重复 model ID；
  因而 profile ID 与 model ID 组成完整、无歧义的选择身份。

### Key、同名与特殊字符

- `composerModelOptions.ts:28-30,37-39,47-50,67-74` 以带类别前缀、字段位置明确的 JSON tuple 生成 key；
  builtin、profile、current 三个命名空间互不碰撞，冒号、斜线、Unicode 只作为 JSON 字符串内容，不能
  改变字段边界。
- `findComposerModelOption` 只在既有选项中按完整 key 查找，不解析 key，也不从 label/model 反推身份。
- `composerModelOptions.test.ts:57-71` 使用相同 model ID/label、不同 connection ID，并把冒号、斜线与中文
  字符放入 ID，证明两项 key 唯一且 lookup 返回不同 identity；伪造的分隔符拼接 key 无法命中。

### 当前缺失模型

- `composerModelOptions.ts:62-83,94-97` 匹配同时比较 vendor、model 与可选 connectionId；已删除 profile、
  未枚举模型或连接身份不同都不会误匹配 catalog，而会在首位生成稳定的 current 项。
- current 项只保留模型选择身份；它不会复制完整 `vendorSettings`。对于 profile 会话仅保留
  `connectionId`，不会把 endpoint、凭据或其它 opaque 字段带进选择项。

### 秘密边界与后续本地化

- `composerModelOptions.ts:37-59,67-82` 逐字段构造输出，没有 spread profile；因此 `baseUrl` 与
  `credentialConfigured` 不进入结果。`ModelConnectionProfile` 的公开类型本身没有 API Key，且映射也不
  复制任何额外运行时字段。测试对 endpoint 值和 credential 派生字段做了负断言。
- `ComposerModelIdentity` 将可选 vendor bag 收窄为唯一允许的 `connectionId`，避免 Base URL、Key 或
  profile label 被持久化为会话 identity。
- `composerModelOptions.ts:8,18-23` 提供稳定语义分组 `builtin | profile | current`；050 可据此用 Lingui
  本地化 builtin/current 分组，而 profile 分组使用用户配置的公开 label。因而后续 UI 无需解析当前英文
  `groupLabel` 来判断分组，也不需要翻译动态 profile 名称。

## 独立验证

- `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/providerRegistry.test.ts apps/web/src/agentNew/ui/composerModelOptions.test.ts`：
  4 files / 35 tests passed。
- `pnpm exec tsc -b tsconfig.app.json --pretty false`：通过；仓库不存在叶文档所写的
  `apps/web/tsconfig.json`，实际 Web 工程由根 `tsconfig.app.json` 覆盖。
- `git diff --check`：通过；两个未跟踪新增文件另以 `git diff --no-index --check` 检查，无 whitespace
  error。
- `wc -l`：`composerModelOptions.ts` 106 行，`composerModelOptions.test.ts` 102 行；职责单一且均不超过
  300 行。

## 范围确认

审查读取 index、010 capability 叶、040 叶、`reports/040-report.md`、两个新增文件及其直接依赖契约；未
修改产品代码、任务文件、index，未暂存、提交或调用子 agent。本次仅新增本审查报告。
