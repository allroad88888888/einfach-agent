# 020 独立审查：开放 DeepSeek 文件传输端点

## 结论

**APPROVED**。指定范围内未发现阻断验收或需要返工的质量问题；C-003 的 browser、host-node、preview 三态语义一致且均为封闭白名单。

## 审查范围

本审查只依据以下材料：

- 任务文件 `.tasks/deepseek-vision-support/020-deepseek-files-routes.md`
- 执行报告 `.tasks/deepseek-vision-support/reports/020-report.md`
- 从基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 得到的指定文件 diff
- 对基准 diff 不显示的 3 个未跟踪文件分别执行的 `git diff --no-index /dev/null <file>`：
  - `apps/web/src/modelTransport/providerRoute.test.ts`
  - `packages/host-node/src/model/providerRouteCatalog.ts`
  - `scripts/model-preview-relay-routes.test.ts`

按要求，没有重跑执行报告已声称运行的测试、类型检查或格式检查，也没有读取或修改产品范围外文件。

## 验收标准逐条判定

### 1. 聚焦允许/拒绝矩阵

✅ **通过。**

证据：

- 执行报告记录指定 vitest 命令 exit 0，3 个测试文件、49 个测试全部通过。
- browser 新增测试覆盖固定 `POST /files`、安全 `DELETE /files/file-api-*`，并拒绝错误方法、Kimi 风格 ID、空后缀、嵌套路径、query 与超长 ID。
- host-node 测试新增成功路由表项断言，并覆盖 DeepSeek 删除 ID 的边界长度、错误 provider、错误方法与未知 target 字段收窄。
- preview 测试覆盖 URL、credential、body kind、响应上限、精确 target 形状，并拒绝非默认 scope 和额外 `url` 字段。
- 部分拒绝情形未在每一态逐项重复成测试，例如 preview 没有单列 `DELETE /files`；但实现的锚定正则/前缀判据明确拒绝该路径，不构成功能缺口。

### 2. TypeScript 类型检查

✅ **按验收意图通过，存在已记录的共享前置错误。**

证据：

- 执行报告明确记录任务给定命令 exit 1：`apps/web/tsconfig.json` 不存在，另有范围外 `packages/agent-ai` readonly 类型错误。
- 报告又用实际 web 配置 `tsconfig.app.json` 补跑；结果只剩 3 处明确归因到共享 worktree 的 `packages/agent-ai` readonly 类型错误，未报告本任务文件错误。
- 因任务自身写入了不存在的配置路径，原命令无法形成绿色结果；补充命令满足“本任务范围没有新增类型错误，只剩明确记录的共享前置错误”的验收意图。
- ⚠️无法核实：共享 `packages/agent-ai` 错误的具体源码与 `tsconfig.app.json` 的存在性均在指定 diff 外；本审查按约束不读取这些文件，也未重跑命令。此项不计为 ❌。

### 3. host 路由文件行数与单一职责

✅ **通过。**

证据：

- 执行报告记录 `providerRoute.ts` 144 行、`providerRouteCatalog.ts` 107 行、`providerRoute.test.ts` 254 行，均不超过普通文件 300 行上限。
- diff 显示 `providerRouteCatalog.ts` 只声明 route entry 结构、固定 origin/limit/path 判据和封闭目录。
- `providerRoute.ts` 只保留外部 target 收窄、目录匹配、origin 解析与 resolved target 组装，路由目录数据已移出。
- 依据 `one-file-one-thing` 的一句话测试、命名测试和引用聚类测试，这次拆分是按职责拆分，不是按行数机械切割；未使用复杂文件例外，也未出现 `utils`/`partN` 式假拆分。

### 4. diff 空白检查

✅ **通过。**

证据：执行报告记录指定 `git diff --check` 命令 exit 0、无输出。按要求未重跑。

## C-003 覆盖矩阵核对

✅ **C-003 已覆盖：browser、host-node、preview 三态文件路由白名单一致。**

| 维度 | browser | host-node | preview |
|---|---|---|---|
| provider / scope | `deepseek` / `default` | `deepseek` / `default` | `deepseek` / `default` |
| 上传 | 精确 `POST /files` | 精确 `POST /files` | 精确 `POST /files` |
| 上传 body | `multipart` | `multipart` | `multipart` |
| 上传响应上限 | 4 MiB | 4 MiB | 4 MiB |
| 删除 | `DELETE /files/<id>` | `DELETE /files/<id>` | `DELETE /files/<id>` |
| 删除 ID | `^file-api-[A-Za-z0-9._-]{1,247}$` | 路径整体锚定到同一 ID 规则 | 同 browser ID 规则 |
| 删除 body | `none` | `none` | `none` |
| 删除响应上限 | 1 MiB | 1 MiB | 1 MiB |
| origin | `DEEPSEEK_BASE_URL` | 固定 `https://api.deepseek.com` | 固定 `https://api.deepseek.com` |

`file-api-` 为 9 个字符，后缀上限 247，因此三态允许的完整 ID 上限一致为 256 字符。

## 安全语义专项核查

### DELETE 仅接受单一安全 `file-api-*` segment

✅ 三态一致且 fail closed。

- browser/preview 先要求 `/files/` 前缀，再对全部剩余字符串应用首尾锚定的 DeepSeek ID 正则。
- host 对完整 path 使用 `^/files/file-api-[A-Za-z0-9._-]{1,247}$`。
- `/`、`?`、`%`、空后缀和非 ASCII 字符都不在字符集中，因此多层路径、query、百分号编码和空 ID 都无法命中。
- Kimi 的宽资源 ID 判据只用于 Kimi 路由；DeepSeek 条目使用独立 `file-api-` 判据，不会接受 Kimi 风格 ID。

### method / origin / body kind fail closed

✅ 三态一致且 fail closed。

- method：只有精确 `POST /files` 与匹配安全 path 的 `DELETE` 分支；其他组合落入拒绝路径。
- origin：browser 由官方 origin binding 识别后还要让生成出的完整 URL 与 route spec 对齐；host origin 来自目录而非调用方；preview 直接从封闭分支生成官方 URL。
- body kind：上传固定为 `multipart`，删除固定为 `none`；调用方不能通过 route target 改写 body kind。
- host 的 target 收窄拒绝未知字段，并禁止 DeepSeek 携带 `connectionId`；preview 的 resolved 路径要求精确字段集合，测试也钉住额外 `url` 的拒绝行为。
- ⚠️无法核实：body kind 在后续 request-body 层如何实际拒绝不匹配 payload 不在指定 diff 内；本范围可以确认三态路由输出的 body kind 是固定且一致的，此项不计为 ❌。

## 质量发现

### Critical

无。

### Important

无。

### Minor

无。

## 非阻断说明

- 任务中的 web TypeScript 配置路径与执行报告所述仓库实际路径不一致，建议编排者后续修正任务模板；这是任务命令问题，不是本次产品实现缺陷。
- 未进行真实 DeepSeek 联网调用；任务目标是白名单传输路由，且该事项已在执行报告中明确记录。
