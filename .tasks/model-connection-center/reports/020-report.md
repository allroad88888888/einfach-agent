# 020 执行报告：探测兼容端点模型

## 改动摘要

- 新增 `connectionProfileProbe.ts`：先复用 `requireOpenAiCompatBaseUrl` 验证并归一化地址，仅请求
  `GET ${baseUrl}/models`；可选 Key 复用 `normalizeApiKey`，只进入本次请求的 Bearer Header。
- probe 注入 fetch，默认 10 秒超时、禁止自动重定向，并对响应实施 256 KiB body 硬顶与 1,000 个模型
  上限；不读取已存 Key、不读写配置。
- 仅接受 `{ data: [{ id: string }] }`，模型 ID trim 后要求非空、无控制字符、UTF-8 不超过 200
  bytes，去重排序并映射为 `{ id, label: id, source: 'discovered' }`。
- 非 2xx、网络、超时、超大、流读取、JSON 与模型形状失败统一返回固定的受控上游错误；不拼接 URL、
  body、Key 或底层异常。只有本域 `ModelRequestError` 可原样穿透，外部 fetch 伪造 `reason` 也不会泄漏。
- 新增并注册 `model_connection_profile_probe`，严格收窄
  `{ input: { baseUrl: string, apiKey?: string } }`；同步命令全集、类型化参数契约、路由与穷举测试。
- web `ModelConnectionProfileHost` 新增 `probe`，server adapter 只转发新命令，static host 始终拒绝。

## 逐条验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/model/connectionProfileProbe.test.ts packages/host-node/src/model/connectionProfileCommands.test.ts packages/host-node/src/commandNames.test.ts packages/host-node/src/createNodeHostInvoke.test.ts`
   - 通过：4 个测试文件、33 个测试全部通过。
   - 覆盖精确 `/models`、地址归一化、可选 Authorization、去重排序、畸形/超大/非 2xx/网络/超时、
     无秘密泄漏、严格命令入参、无配置写入、命令登记与分发。
2. `pnpm exec vitest run apps/web/src/settings/serverModelConnectionProfileHost.test.ts`
   - 通过：1 个测试文件、2 个测试全部通过。
   - 覆盖 server probe command/payload/result 窄化与 static host 拒绝。
3. `pnpm --filter @einfach-agent/host-node build`
   - 通过：tsup、host-node build tsconfig、声明文件修正全部成功。
4. `pnpm exec tsc -b`
   - 未通过：020 自身 probe test 的类型问题已修复；剩余错误均位于范围外的旧单模型下游消费方，主要是
     `ModelConnectionProfile.model` 尚未迁移为 `models`，以及旧测试 mock 尚未实现新增 `probe`。
   - index 已裁决全仓 `tsc -b` 总门移至 060/070；本叶未修改这些范围外文件。
5. `git diff --check`
   - 通过，无空白错误。
6. `wc -l` 对本任务所有允许文件检查
   - 通过：新增/修改普通文件均不超过 300 行；最大为存量 `commandArgs.ts` 281 行。

## 未验证项

- 未真实联网请求任何上游；按全局约束全部使用注入 fetch 模拟。
- 未单独验证浏览器控制面调用 probe；该消费由后续 030/060 负责。
- 全仓 `tsc -b` 未闭合，原因见上述验收第 4 项及“范围外发现”。

## 范围外发现

- `apps/web/src/agentNew/ui/ModelConnectionProfileSettings.tsx`、
  `apps/web/src/settings/modelConnectionProfileCommands.ts`、相关 UI/setting tests 与 runtime 仍使用旧的
  单一 `profile.model` 契约。
- 若干范围外测试自行构造 `ModelConnectionProfileHost` mock，尚未添加 `probe` 方法。它们会在 030/060
  消费面迁移前导致全仓类型检查失败。

## 疑虑

- 无 020 实现层疑虑。当前唯一交付疑虑是共享工作树处于 010 后、030/060 前的公开类型中间态，故不能
  在本叶声称全仓类型总门已通过。

## 建议后续动作

- 030/060 迁移旧 `model` 消费方到 `models`，并为所有 `ModelConnectionProfileHost` mock 增加 probe。
- 060/070 按 index 裁决重跑 `pnpm exec tsc -b` 全仓总门及完整模型中心验收。
