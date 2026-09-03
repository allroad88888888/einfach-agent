# 002 CLI 与宿主执行同一模型凭据和端点安全规则

## 改动摘要

- host-node 公开只读模型配置契约：凭据键绑定、API Key 归一化、`modelCredentials` 段读取 codec，以及 openai-compatible base URL 的键与归一化判据。
- CLI 不再维护配置键字面量或 URL 安全判据；环境变量和 `config.json` 都消费 host-node 契约。有效环境变量优先与 DeepSeek 无文件快速路径保持不变。
- 增加 CLI 对空白/超长 Key、坏配置段、HTTPS/回环 HTTP 接入点归一化、远程 HTTP/URL credentials/query/fragment 拒绝及环境优先级的回归测试。
- 补充 `credentialSection.test.ts`，覆盖任务验收命令所列的 host codec 测试入口。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm vitest run apps/cli/src/credentials.test.ts apps/cli/src/runtime.test.ts packages/host-node/src/model/openAiCompatBaseUrl.test.ts packages/host-node/src/model/credentialSection.test.ts` | 通过：4 个测试文件、57 个测试。 |
| `pnpm exec tsc -b apps/cli/tsconfig.json packages/host-node/tsconfig.json` | 通过。 |
| `git diff --check -- apps/cli/src/credentials.ts apps/cli/src/credentials.test.ts apps/cli/src/runtime.ts apps/cli/src/runtime.test.ts packages/host-node/src/model packages/host-node/src/index.ts` | 通过，无空白错误。 |
| `wc -l`（本次改动文件） | 通过：最大 164 行，均低于 300 行上限。 |

## 未验证项

- 未运行全仓测试套件；任务规定的定向测试与两个相关 TypeScript 项目已验证。

## 范围外发现

- 无。

## 疑虑

- 无。

## 建议后续动作

- 由编排者按任务文件范围审阅并创建独立提交；不得包含并行任务的改动。
