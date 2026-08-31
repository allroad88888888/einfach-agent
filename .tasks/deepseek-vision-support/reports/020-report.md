# 020 执行报告：开放 DeepSeek 文件传输端点

## 改动摘要

- browser transport：在固定 `https://api.deepseek.com` origin 下开放 multipart `POST /files`，以及
  无 body 的 `DELETE /files/file-api-*`；删除 ID 只接受安全 ASCII 资源字符、非空后缀且总 ID 不超过
  256 字符。
- Node host：把可信 origin、路由、body kind 和响应上限抽到
  `providerRouteCatalog.ts`，`providerRoute.ts` 只保留外部请求收窄与目录匹配。DeepSeek 文件路由与
  Kimi 既有路由使用相同的 4 MiB 文件响应上限和 1 MiB 删除响应上限，但使用独立的 DeepSeek ID
  规则。
- preview relay：同步开放相同 DeepSeek origin、方法、路径、body kind、credential 与响应上限策略。
- 三处均拒绝 Kimi 风格 ID、空 `file-api-` 后缀、query、多层路径、过长 ID、错误方法/作用域及额外
  target 字段；没有开放任意 origin 或任意 path segment。
- `one-file-one-thing` 对实现的直接影响：host 路由目录与请求解析已按职责拆分，没有使用复杂文件例外。

## 逐条验收命令与结果

1. `pnpm exec vitest run apps/web/src/modelTransport/providerRoute.test.ts packages/host-node/src/model/providerRoute.test.ts scripts/model-preview-relay-routes.test.ts`
   - 通过，exit 0。
   - 3 个测试文件通过，49 个测试通过。
2. `pnpm exec tsc -b packages/host-node/tsconfig.json apps/web/tsconfig.json`
   - 未全绿，exit 1；失败均不是本任务 files 内错误。
   - 共享 worktree 前置错误：`packages/agent-ai/src/deepseek.ts:142,148` 与
     `packages/agent-ai/src/deepseekMessages.ts:56` 的 readonly `UserContentBlock[]` 到 mutable
     `DeepSeekContentBlock[]` 类型不兼容。
   - 命令路径错误：仓库不存在 `apps/web/tsconfig.json`，TypeScript 报 TS5083；实际 web 配置位于
     根目录 `tsconfig.app.json`。
   - 补充执行 `pnpm exec tsc -b packages/host-node/tsconfig.json tsconfig.app.json`，结果仅剩上述
     `packages/agent-ai` 三处共享 readonly 类型错误，未报告本任务文件错误。
3. `wc -l packages/host-node/src/model/providerRoute*.ts`
   - 通过：`providerRoute.ts` 144 行，`providerRouteCatalog.ts` 107 行，`providerRoute.test.ts`
     254 行，均不超过 300 行。
4. `git diff --check -- apps/web/src/modelTransport packages/host-node/src/model scripts/model-preview-relay-routes*`
   - 通过，exit 0，无输出、无空白错误。

## 补充验证

- `pnpm exec vitest run apps/web/src/modelTransport/modelEndpoint.test.ts apps/web/src/modelTransport/devPreviewModelTransport.test.ts scripts/model-preview-relay.test.ts`
  - 通过，3 个测试文件、29 个测试全部通过；既有 browser endpoint、Kimi preview multipart/DELETE
    与完整 relay 转发未回归。
- `pnpm check:boundaries`
  - 通过，扫描 901 个非测试 TS/TSX 文件；输出仅含仓库既有豁免观察项。

## 已完成覆盖矩阵行及证据

- `C-003`：browser、host-node、preview 三态文件路由白名单。
  - browser 证据：`apps/web/src/modelTransport/providerRoute.test.ts` 验证固定 DeepSeek 上传/删除 URL、
    multipart/none body kind、响应上限与拒绝矩阵。
  - host-node 证据：`packages/host-node/src/model/providerRoute.test.ts` 验证目录解析结果、固定官方 origin、
    `file-api-*` 边界长度与 provider/method 拒绝矩阵。
  - preview 证据：`scripts/model-preview-relay-routes.test.ts` 验证 route、credential、body kind、响应上限、
    精确 target 形状与拒绝矩阵。
  - 聚焦验收结果：49/49 测试通过。

## 未验证项

- 未进行真实 DeepSeek 联网调用；全局约束明确禁止未授权真实联网，且本交付为传输白名单。
- 全量 TypeScript build 未能得到绿色结果，原因仅为上文已归因的共享 `agent-ai` 前置错误与验收命令
  中不存在的 web tsconfig 路径。

## 范围外发现

- 并行任务正在修改 `packages/agent-ai/src/deepseek.ts` 与 `deepseekMessages.ts`，当前 readonly 类型不兼容
  会阻断本任务的组合 tsc 验收；未越界修改。
- 任务文件列出的 `apps/web/tsconfig.json` 在仓库中不存在；实际 web 配置是根目录
  `tsconfig.app.json`；未修改任务定义。
- 本任务触及的既有文件含其他人在途 profile/connection 修改；实现已在其上增量叠加并保留，未做
  reset、checkout、暂存或提交。

## 疑虑

- 无产品行为疑虑。唯一未闭环项是共享 worktree 的 TypeScript 前置错误，因此状态应由编排者在 010
  合并/修复后重跑总门确认。

## 建议后续动作

1. 010 修复或完成 `agent-ai` 的 readonly DeepSeek message 类型后，重跑
   `pnpm exec tsc -b packages/host-node/tsconfig.json tsconfig.app.json`。
2. 编排者后续更新任务验收命令，将不存在的 `apps/web/tsconfig.json` 改为 `tsconfig.app.json`。
3. 在 040/050 接入真实 adapter fetch 后继续复用本任务已开放的固定 routes，不扩大 origin、方法或
   path 白名单。
