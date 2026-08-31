# 020 独立审查

## 结论

**REJECT**

最终 wire 的 capability 收窄主体正确，但 `thinking` 对象没有规范化，且 agent-ai 全套回归仍为红；当前不能完成
020。

## Findings

- [MEDIUM] `packages/agent-ai/src/builtinProviders.ts:88-93,110-123` 只检查
  `thinking.type` 是否为 `enabled|disabled`，随后把调用方原对象直接写入请求。因而从运行时 JSON/body
  进入的 `{ type: 'enabled', unexpected: 'leak' }` 会原样到达上游，而不是收窄为唯一合法形状
  `{ type: 'enabled' }`。只读运行时探针捕获到最终 body 为
  `"thinking":{"type":"enabled","unexpected":"leak"}`。这违反本叶“只向上游发送当前模型支持的
  Thinking 字段”与审查要求中的 thinking object 规范化；当前新增测试的 helper 只生成规范对象，未覆盖
  该边界。应从合法 `type` 重建 canonical object，并用最终 fetch body 测 enabled/disabled 带多余字段及
  非法 object 的行为。
- [MEDIUM] agent-ai 全套回归未通过：
  `pnpm exec vitest run packages/agent-ai/src ...` 为 1 file failed / 30 files passed、2 tests failed /
  245 passed。失败均在 `packages/agent-ai/src/builtinProviders.test.ts:92-120`：DeepSeek 与 GLM 的既有/在途
  “identity 决定私有投影”用例仍期望未显式开启 Thinking 时发送 `reasoning_effort`；DeepSeek 用例还使用
  已不在受审 catalog 中的 `DeepSeek-R1`。新投影按当前契约正确地省略 effort，因此这里首先是未随新契约
  收敛的回归测试，但仓库测试门仍为红，不能 APPROVE。应把用例改为受支持的精确模型并显式传
  `thinking: { type: 'enabled' }`，同时保留“未开启时不发送 effort”的反向断言。

## 已确认正确的 wire 行为

- DeepSeek V4 Pro/Flash：enabled 时仅 `high|max` 上行；Auto 省略 effort；disabled 与脏 effort 均不发
  effort。最终 fetch body 测试覆盖这五类状态。
- GLM-5.2：`low|medium|high|xhigh|max` 正向值均上行；脏值省略；`minimal|none` 被统一规范为
  `thinking: { type: 'disabled' }` 且不带 effort。
- 其他 GLM：精确 capability 为 toggle 时保留合法 `thinking.type` 并删除 body/settings 中残留 effort；
  unsupported 模型不获得 Thinking 字段。
- Kimi K2.6：只保留 toggle，不发送 effort；`kimiChat.test.ts` 证明既有 assistant/tool 消息编码保持，
  agent-ai 其余 Kimi 文件/usage 测试也通过。
- `packages/agent-ai/src/builtinProviders.ts:95-115` 以请求 settings 的实际 vendor 加精确 model catalog
  查询能力；未知 vendor 虽仍走 DeepSeek execution fallback，也不会继承 DeepSeek Thinking。已知 vendor
  的未知 model 同理由精确查询 fail closed。
- body 顶层的 `reasoning_effort` 在投影入口直接剥离，只有 settings 中经 capability 白名单验证的 effort
  才能重建；unsupported/unknown/toggle、disabled、Auto 与脏 settings 值均不会夹带 effort。
- OpenAI-compatible descriptor 没有模型能力，profile/legacy 请求均删除未受审 `thinking` 与
  `reasoning_effort`。既有 connection profile、legacy endpoint 与标准协议回归的 5 files / 30 tests
  全部通过，未发现 transport identity 或 endpoint 回归。

## 独立验证

- 叶声明命令：3 files / 29 tests passed；命令中列出的 `glm.test.ts` 当前不存在，Vitest 静默跳过该路径，
  GLM wire 覆盖实际来自新增 `thinkingRequestProjection.test.ts`。
- `pnpm --filter @einfach-agent/ai build`：passed。
- `git diff --check`：passed；新增测试另以 `git diff --no-index --check` 检查通过。
- OpenAI-compatible 回归：
  `connectionProfileTransport`、`legacyOpenAiCompatTransport`、`openAiCompatEndpoint`、
  `openaiCompat`、`providerRequestVendorDivergence` 共 5 files / 30 tests passed。
- 行数：`builtinProviders.ts` 260、`glm.ts` 59、新增 `thinkingRequestProjection.test.ts` 122，均不超过
  300。存量 `deepseek.test.ts` 359 行且本叶未修改，按任务明确豁免，不要求本叶重构。

## 范围确认

审查覆盖 index、010 capability 叶与报告、020 叶与报告、最终相关源码、tracked/untracked diff、新增协议
测试及共享 worktree 的 OpenAI-compatible 在途回归。除本报告外未修改任何产品、测试、task 或 index
文件，未暂存、提交或派发子 agent。
