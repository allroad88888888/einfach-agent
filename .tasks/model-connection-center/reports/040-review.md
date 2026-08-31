# 040 独立审查

## 结论

APPROVED。限定范围内的实现满足任务目标与两项验收标准，未发现阻断或需要返工的质量问题。

## 审查范围

本审查只依据以下材料：

- `.tasks/model-connection-center/040-connection-preset-registry.md`
- `.tasks/model-connection-center/reports/040-report.md`
- `modelConnectionPresetRegistry.ts` 与 `modelConnectionPresetRegistry.test.ts` 相对 `/dev/null` 的新增文件 diff

按任务裁决，不以全 app TypeScript 总门的范围外中间态作为本轮失败，也未重跑执行报告已声明的命令。

## 验收标准

### ✅ 1. 专属 Vitest 覆盖并通过

执行报告记录 `pnpm exec vitest run apps/web/src/settings/modelConnectionPresetRegistry.test.ts` 通过：1 个测试文件、3 个测试。

范围 diff 对任务所列行为给出了直接证据：

- 首批预设完整：`lm-studio`、`ollama`、`openrouter`、`sglang`、`siliconflow`、`vllm`、`volcengine-ark`，类别分别覆盖 local、cloud、self-hosted；未加入官方 `deepseek`、`glm`、`kimi` key。
- 每个预设协议固定为 `openai-compatible`，每个示例 model 都由 `copyPreset` 生成并标记 `source: 'manual'`。
- vLLM、SGLang 的 `baseUrl` 为空；其他非空地址逐项断言 `normalizeOpenAiCompatBaseUrl(baseUrl) === baseUrl`，包含既有回环 HTTP 形式的 Ollama 与 LM Studio。
- 定义按稳定 kebab-case 应用 key 顺序排列，测试精确断言完整 ID 顺序。
- `modelConnectionPresets()` 每次映射出新 preset 和新 model 对象；`modelConnectionPreset(id)` 同样返回新副本。测试修改返回值中的 preset label 与嵌套 model label 后，再查询仍得到原值，并覆盖未知 ID 返回 `undefined`。

因此 category、协议、合法地址/可空自部署地址、稳定排序与防御性副本均有实现和通过测试的证据。

### ✅ 2. `git diff --check` 通过

执行报告记录 `git diff --check` 无输出并通过；同时记录两个新增文件相对 `/dev/null` 的 `--check` 均无格式错误输出。返回码 1 仅表示存在新增文件 diff，不是 whitespace 检查失败。

## 质量发现

### Critical

无。

### Important

无。

### Minor

无。

## 额外质量核对

- 单一职责成立：实现文件只负责连接来源预设 registry；测试文件只验证该 registry。
- 文件规模合规：执行报告与限定材料显示实现 101 行、测试 56 行，均低于普通文件 300 行硬上限。
- 实现不请求网络、不读写 config、不渲染 UI，符合任务边界。
- 报告声明的全 app `tsc` 问题属于并行迁移中间态，且任务明确将该总门移交 060/070；不构成本轮缺陷。
