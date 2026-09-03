# 003 执行报告

状态：`DONE_WITH_CONCERNS`

## 改动摘要

- 将环境中立的 provider transport policy 收口到 `packages/agent-ai/src/providerTransport.ts`：
  - 8 条 route policy（含 7 条官方路由与 1 条动态 openai-compatible 路由）。
  - DeepSeek、GLM、Kimi CN 三个官方 origin。
  - request body、wire envelope、response 限额。
  - multipart part name、file name、content type、通用资源 ID 与 DeepSeek file ID 的纯判据。
- 新增无依赖叶模块 `providerOrigins.ts` 作为四个官方 provider base URL 的唯一字面量 owner；
  DeepSeek/GLM/Kimi adapter 与 transport policy 均直接消费该模块，adapter 原公开导出保持兼容。
- Web、host-node、开发 relay 均改为消费同一 route policy；三端仍分别保留各自信任边界的输入解码与错误翻译。
- openai-compatible 只共享 method/path/body/limit 元数据；origin 仍由 Web/host 的登记表解析，未下沉凭据或运行时状态。
- Web、host-node、relay 的 multipart 元数据校验改用共享判据；文件名统一拒绝 C0/C1 控制字符、路径分隔符和 UTF-8 超限值。
- host request envelope 与 server HTTP body cap 改用共享 `maxWireRequestBytes`；route response cap 改由共享 policy 给出。
- DeepSeek 上传响应、消息引用、删除路径统一使用原消息引用侧的严格 `file-api-*` 判据；删除路径不再额外接受点号。
- `host-node` 增加对 `@einfach-agent/ai` 的正式 workspace 依赖，并同步 lockfile。
- host-node 声明构建显式映射 agent-ai/core dist，并更新 tsup 构建拓扑说明；server body cap
  注释改为指向共享 `PROVIDER_TRANSPORT_LIMITS.maxWireRequestBytes` owner。
- 新增共享 policy/predicate 测试、relay body 测试、三端 policy 对拍，以及 DeepSeek ID 三路径一致性测试。

## 逐条验收

1. **现有 provider route、wire body、request body、relay 测试通过。**
   - 扩大回归命令覆盖整个 `apps/web/src/modelTransport`、`packages/host-node/src/model`，以及 agent-ai policy/DeepSeek、server model route、relay route/body/handler。
   - 修复轮扩大覆盖 `builtinProviders.test.ts`，结果：`38 passed` test files，`370 passed` tests。
2. **新增三端 policy 对拍。**
   - `scripts/model-preview-relay-routes.test.ts` 遍历共享 policy 的全部 7 条官方路由。
   - 每条同时比较 Web、host-node、relay 的 `method`、实际 `path`、`bodyKind`、官方 origin 拼接结果与 `maxResponseBytes`。
   - 三个官方 origin 均由共享表覆盖；测试通过。
   - 新增 adapter 导出 base URL 与 policy origin 的逐家同源断言；生产源码搜索确认四个官方 URL
     字面量只存在于 `providerOrigins.ts`。
3. **C0/C1 文件名与 DeepSeek file ID 一致。**
   - Web、host-node、relay 均消费共享 file-name predicate；C0/C1 定向用例通过。
   - DeepSeek ID 对拍直接覆盖上传响应、消息投影与 DELETE route，合法/非法样例三路径结论相同；测试通过。
4. **TypeScript 验证。**
   - 任务原命令不能原样完成：仓库不存在 `apps/web/tsconfig.json`，原命令报 `TS5083`。
   - 将末项替换为仓库现有 `tsconfig.app.json` 后通过：
     `pnpm exec tsc -b packages/agent-ai/tsconfig.json packages/host-node/tsconfig.json apps/server/tsconfig.json tsconfig.app.json`
   - 另分别运行 agent-ai、host-node、server 的 `tsc -p ... --noEmit`，并用只包含本任务 Web 文件的临时 tsconfig 隔离检查，四项均通过。
   - 按新拓扑连续执行 `@einfach-agent/ai` 与 `@einfach-agent/host-node` package build，均通过。

## 其他验证

- `git diff --check`：通过。
- lockfile 曾用 `pnpm install --lockfile-only --frozen-lockfile` 校验依赖一致性；由 pnpm 自动产生的无关键排序已还原，最终 lockfile 仅增加 host-node → agent-ai 依赖。
- 按 `one-file-one-thing` 规则执行物理行审计：本任务全部源码/测试文件不超过 300 行；最大为
  `deepseek.ts` 的 272 行，共享 policy 文件为 249 行，新 origin 叶模块为 5 行。

## 未验证项

- 无法按任务文本原样验证不存在的 `apps/web/tsconfig.json`；已使用现有项目配置与隔离检查替代，详见验收 4。

## 范围外发现

- 验收命令引用的 `apps/web/tsconfig.json` 在仓库中不存在；Web 当前由根 `tsconfig.app.json` 覆盖。

## 疑虑

- DeepSeek DELETE 现在与既有上传/消息 validator 一致，不再接受 `file-api-image.one` 这类带点号 ID。这是收敛到原有严格 owner 的有意行为；若上游未来正式返回带点 ID，需要在共享判据一处放宽并由三路径测试共同确认。

## 建议

- 后续任务说明中的类型检查命令应将 `apps/web/tsconfig.json` 改为 `tsconfig.app.json`；若确实希望 Web 独立 project，则应另行创建并纳入仓库，而不是让验收命令引用不存在的文件。
