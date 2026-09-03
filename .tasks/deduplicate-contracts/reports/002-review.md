# 002 独立审查

## 结论

**APPROVED**。范围内实现满足任务的四项验收标准；未发现 Critical 或 Important 问题。存在 1 项不阻断验收的测试覆盖细节，见 Minor。

审查仅基于任务文件、执行报告、`git diff 55a3d2e -- <任务范围>`，以及范围内唯一未跟踪文件 `packages/host-node/src/model/credentialSection.test.ts`。按要求没有重跑执行报告声称已运行的测试。

## 验收标准逐条判定

### ✅ 1. 指定 Vitest 命令全部通过

- 执行报告记录：4 个测试文件、57 个测试全部通过。
- 指定入口均存在；其中新增但未跟踪的 `packages/host-node/src/model/credentialSection.test.ts` 已直接检查，覆盖有效字符串读取、共享 Key 归一化，以及非对象/数组/null/非字符串成员的整段拒绝。
- 本 reviewer 按要求未重跑该命令，因此通过状态的证据来自执行报告。

### ✅ 2. CLI 测试证明不安全 URL 被拒，安全 URL 被归一化接受

- `apps/cli/src/credentials.test.ts:124-136` 覆盖 HTTPS、`127.0.0.1` HTTP、`localhost` HTTP，并验证末尾斜杠归一化。
- `apps/cli/src/credentials.test.ts:138-151` 覆盖远程 HTTP、URL credentials、query、fragment，结果均为不产生 `openai-compat` base URL。
- 生产代码 `apps/cli/src/credentials.ts:78-85` 对环境值直接调用 host 导出的 `normalizeOpenAiCompatBaseUrl`；配置值在 `apps/cli/src/credentials.ts:131-135` 调用同一函数，不存在 CLI 自有安全判据副本。
- `apps/cli/src/runtime.ts:70-73` 只在解析结果中确有 base URL 时注册 adapter，因此被拒值不会进入运行时端点。

### ✅ 3. CLI 与 host 对 Key/配置段语义一致，环境变量优先

- 配置键不再由 CLI 保存字面量：`apps/cli/src/credentials.ts:126-130` 使用 host 的 `credentialConfigKey(provider, scope)`；openai-compatible base URL 键使用 host 的 `OPENAI_COMPAT_BASE_URL_CONFIG_KEY`。
- 环境 Key 与配置 Key 分别在 `apps/cli/src/credentials.ts:69-75`、`:65-67` 调用同一个 host `normalizeApiKey`，因此首尾空白、空白值和超过 1024 UTF-8 字节值遵循同一规范。
- 配置段由 host 的 `readModelCredentialSnapshotKey` 解码。host `credentialSection.ts:44-53` 先验证整个 section 是 string-to-string map，再读取目标键；CLI 没有复制 section codec。
- `apps/cli/src/credentials.test.ts:93-122` 验证空白/超长 Key 与非字符串成员；新增 host section 测试验证同一 codec 的结果。
- API Key 环境优先仍由 `fromEnvironment[vendor] || valueFromConfig(...)` 保持（`apps/cli/src/credentials.ts:129`）；base URL 环境优先由预填 `modelBaseUrls` 后仅在缺项时读配置保持（`:125`、`:131`）。测试 `:153-163` 明确验证 base URL 环境优先。

### ✅ 4. 指定 TypeScript build 通过

- 执行报告记录 `pnpm exec tsc -b apps/cli/tsconfig.json packages/host-node/tsconfig.json` 通过。
- 本 reviewer 按要求未重跑该命令，因此通过状态的证据来自执行报告。

## 重点安全与边界检查

### DeepSeek 无文件快速路径

✅ 保持有效且安全处理其他 provider 的坏环境 URL。`apps/cli/src/credentials.ts:114-120` 在 DeepSeek 短路判断之前先调用 `baseUrlsFromEnvironment`；后者已通过 host URL normalizer 过滤所有 openai-compatible 环境值。因此即使 DeepSeek Key 触发不读文件，远程 HTTP、credentials/query/fragment 等坏环境 URL 也不会进入返回的 `modelBaseUrls`。短路仍避免读取可选配置文件，现有测试 `credentials.test.ts:6-16` 与 `:68-81` 覆盖不读文件及该路径的 base URL 搬运。

### host 规范复用

✅ 配置 section、credential key、API Key 归一化、base URL config key 与 URL 归一化全部从 `@einfach-agent/host-node` 消费。CLI 仅保留属于自身装配职责的环境变量名与 provider/scope 清单。

### 导出边界与循环依赖

✅ 新增公开面只有 5 个只读函数/常量及 2 个闭合类型；没有导出 section editor、写/删函数或可变内部状态。`packages/host-node/src/model/index.ts:124-130` 汇入域边界，再由包根 `packages/host-node/src/index.ts:97-105` 明确导出。

✅ 范围内依赖方向为 CLI → host 包根 → model 域 → 具体叶模块；叶模块没有反向导入 model/package index，未形成新的循环依赖。

### 错误不泄露密钥

✅ 新增失败路径不拼接输入值：坏 URL 静默归为 `undefined`；坏 section 由 host `modelRequestError('invalidConfigFormat')` 产生固定文案“模型配置文件格式无效”；缺少 DeepSeek 的错误只列环境变量名、配置键名与配置路径。未发现 API Key 或 URL credentials/query 被写入错误文本的路径。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. `credentials.test.ts` 的坏 URL 参数化用例走的是“无 DeepSeek 环境 Key、读取配置文件”的分支；虽然生产代码清楚表明同一 normalizer 在 DeepSeek 短路之前执行，且当前实现安全，但没有一个测试把 `DEEPSEEK_API_KEY` 与坏 `OPENAI_COMPAT_BASE_URL` 组合起来，直接锁住本次重点检查的交互。建议后续补一个短路分支坏 URL 回归用例，不阻断当前验收。

## 其他核实结果

- 文件职责符合 `one-file-one-thing`：改动文件最大 164 行，均低于 300 行；新增测试文件 25 行，职责单一。
- 范围 diff 的 `git diff --check` 无输出；该检查由 reviewer 执行，不属于被要求禁止重跑的测试命令。
- ⚠️ 无法核实：全仓测试、范围外调用方与范围外改动未纳入本次审查；执行报告也明确未运行全仓测试。
