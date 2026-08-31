# 010 执行报告

## 改动摘要

- 将 host 持久化与公开 profile 从单个 `model` 迁移为非空、稳定顺序的 `models`。
- 新增 `ConnectionProfileModel`，严格限制为 `{ id, label, source }`；`source` 仅允许 `manual | discovered`。
- 对模型 ID 沿用 200-byte 与控制字符保护，对模型 label 使用 120-byte 受限文本保护；拒绝空数组、重复模型 ID、未知模型字段和未知 save 字段。
- 严格兼容旧 `{ model: string }` 持久化记录：只在内存中投影为单个 manual 模型，读取不写盘，下一次成功 save 才写成新形状。
- 保留 profile 元数据与 credential section 的单快照原子事务、omit-key 语义、连接级 Key 隔离和旧会话转发链。
- 更新限定范围内的 host/web contract 与测试，公开响应仍只含 `credentialConfigured`，不含 API Key。
- R1 将静态 `ConnectionProfileCommandArgs` save input 同步为 `models: readonly ConnectionProfileModel[]`，彻底移除旧 `model` 字段。
- `one-file-one-thing` 自检：所有本任务文件均不超过 300 行，未增加职责混杂文件。

## 逐条验收命令与结果

1. `pnpm exec vitest run packages/host-node/src/model/connectionProfileValidation.test.ts packages/host-node/src/model/connectionProfileTransaction.test.ts packages/host-node/src/model/connectionProfileCommands.test.ts packages/host-node/src/model/connectionProfileForward.test.ts packages/host-node/src/model/connectionProfileForwardBinding.test.ts`
   - 通过：5 个测试文件、25 个测试全部通过。
   - 覆盖新旧记录、读取不主动迁移写盘、下一次 save 写新形状、模型校验/去重、原子保存与删除、同 URL Key 隔离、旧 endpoint 转发。
2. `pnpm exec vitest run apps/web/src/settings/serverModelConnectionProfileHost.test.ts`
   - 通过：1 个测试文件、1 个测试通过。
   - save payload 和公开响应使用多模型形状；响应序列化不含 write-only Key。
3. `pnpm --filter @einfach-agent/host-node build`
   - 通过（R1 后复跑）：tsup、host-node TypeScript build 与声明说明符修复全部成功。
4. `git diff --check`
   - 通过，无空白错误。
5. `rg -n "models|\\bmodel\\b" packages/host-node/src/model/connectionProfileCommandArgs.ts`
   - 通过：唯一 save 模型字段是第 12 行的 `models: readonly ConnectionProfileModel[]`，不存在旧 `model`。
6. `wc -l`（任务列出的全部源文件与测试文件）
   - 通过：最大 204 行，全部低于普通文件 300 行上限。

## 未验证项

- 全仓 `tsc -b` 按更新后的任务裁决移至 030/060 消费端迁移后的总门，本轮未复跑。
- 未联网请求真实上游（全局约束禁止，转发测试使用本地注入 harness）。

## 范围外发现

- 多个现存 web 控制面文件仍直接依赖 `ModelConnectionProfile.model`；更新后的任务已明确将这些消费端迁移与全仓 `tsc -b` 总门交给 030/060。

## 疑虑

- 无本任务范围内已知疑虑。静态命令参数契约与运行时 handler 现已一致。

## 建议后续动作

1. 由 030/060 按任务树迁移 web 草稿、默认连接、面板与相关测试到多模型 contract。
2. 下游迁移完成后按 index 裁决运行全仓 `pnpm exec tsc -b` 总门。
