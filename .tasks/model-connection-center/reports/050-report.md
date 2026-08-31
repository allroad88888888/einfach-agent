# 050 执行报告：解析非秘密连接清单

## 改动摘要

- 新增 `apps/web/src/settings/modelConnectionProfileManifest.ts`：纯浏览器 JSON 解析器，将精确的非秘密 manifest 转为 `ImportedModelConnectionProfile` 草稿；不发网络、不写入 atom 或持久化。
- 根、`connection`、各 model 均使用字段白名单；`id`、`apiKey`、`token`、`headers`、`apiPath`、adapter 声明及任何未知字段都会拒绝。
- 输出不含 connection ID 或任意秘密字段；每个模型固定为 `source: 'manual'`。
- 浏览器内 URL 规则与 host `normalizeOpenAiCompatBaseUrl` 保持字面等价：先 trim、512 字符上限、URL 解析、禁用户名/密码/query/fragment、只允许 HTTPS 或回环 HTTP、去末尾斜杠。
- 设置了 manifest 文本（64 KiB）、模型数（100）、显示名（128）和模型 ID（256）上限；所有错误为固定中文用户提示，不回显输入。
- 新增 `apps/web/src/settings/modelConnectionProfileManifest.test.ts`，覆盖最小合法格式、可选 model label、重复 ID、未知/秘密字段、危险 URL、回环 HTTP、超限文本和无秘密输出。

文件职责及行数：

- `modelConnectionProfileManifest.ts`（107 行）：只负责 manifest 安全解析。
- `modelConnectionProfileManifest.test.ts`（87 行）：只负责该解析器的契约测试。

## 验收命令与结果

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileManifest.test.ts`
   - 通过：1 个文件、16 个测试全部通过。

2. `pnpm exec tsc -p tsconfig.app.json --noEmit`
   - 未通过，失败均为任务范围外的共享 worktree 中旧单模型消费者未迁移：例如 `ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx`、`modelConnectionProfileCommands.ts`、`modelConnectionProfileState.ts`、`defaultModelConnectionRuntime.ts` 仍读取 `profile.model` 或构造旧 `model` 字段；另有 host probe 命令类型未同步。该任务新增的解析器未出现在 TypeScript 错误中。

3. `git diff --check`
   - 通过，无空白错误。

4. `wc -l apps/web/src/settings/modelConnectionProfileManifest.ts apps/web/src/settings/modelConnectionProfileManifest.test.ts`
   - 通过：分别 107 行、87 行，均低于 300 行上限。

## 未验证项

- 因范围外共享类型迁移尚未完成，无法取得全应用 `tsc -p tsconfig.app.json --noEmit` 通过结果。
- 060 尚未接入文件选择 UI，故未进行实际 UI 导入流程验证；本任务只提供纯函数。

## 范围外发现

- 010 的 `models` 契约已落地，但多个浏览器 UI、状态、命令和测试仍是旧单模型 `model` 形态；这正是当前应用级 TypeScript 失败原因。
- `packages/host-node/src/commandArgs.ts` 的 `model_connection_profile_probe` 命令联合类型与 `NodeHostCommandArgs` 尚未同步。

## 疑虑

- 无本任务实现疑虑。全局 TypeScript 门仍依赖 020/030/060 等下游任务完成其共享契约迁移。

## 建议后续动作

- 由负责 020/030/060 的任务完成对应的 profile probe、草稿状态和 UI 消费方迁移后，重跑应用级 TypeScript 总门。
- 060 接入时仅将本解析器的返回值交给草稿命令，并在 UI 中生成或要求用户填写本地 connection ID，切勿扩展 manifest 格式。
