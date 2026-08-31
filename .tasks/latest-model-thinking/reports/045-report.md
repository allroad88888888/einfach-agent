# 045 执行报告：续接 Kimi K3 图片链路

状态：`DONE`

## 变更

- 将 Kimi 图片 capability 重命名为 `KIMI_K3_IMAGE_INPUT`，并让 K3 的精确 descriptor 使用它；不保留旧模型 alias。
- Kimi CN 上传继续使用受控 Moonshot CN `/files` endpoint，产物为 `kimi:cn` scope 的合法 `ms://` provider-file 引用。
- 保持上传事务的既有 cleanup 语义：部分失败、取消和显式 rollback 均删除已成功上传的文件；rollback 仍为幂等，最多触发一次删除。
- K3 消息编码与历史图片兼容夹具更新为精确 K3 guard；跨 provider、跨 region 和非法引用继续显示为 placeholder。
- Web 侧图片准备继续只把 K3 路由至 Kimi adapter；global region 在 adapter transport 前明确拒绝，未扩大能力。
- 经编排者批准，额外修改 `packages/agent-ai/src/builtinModelDescriptors.ts`，将其遗留的 K2.6 capability import 切换为 K3；该文件是 K3 精确图片 guard 的唯一 catalog 消费者。

## 命令证据

```sh
pnpm exec vitest run \
  packages/agent-ai/src/imageCapability.test.ts \
  packages/agent-ai/src/kimiFiles.test.ts \
  packages/agent-ai/src/kimiFiles.transaction.test.ts \
  packages/agent-ai/src/kimiMessages.test.ts \
  packages/agent-ai/src/historyImageCompatibility.test.ts \
  apps/web/src/modelInput/prepareProviderUserInput.test.ts \
  apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.test.tsx
# 7 files passed; 32 tests passed

pnpm exec tsc -b --pretty false
# exit 0

pnpm check:state
# exit 0; 5 rules passed

pnpm check:boundaries
# exit 0; 7 rules passed; only existing observation exemptions

git diff --check
# no output

rg -n "KIMI_K2_6|kimi-k2\\.6|Kimi K2\\.6" <045 product files plus builtinModelDescriptors.ts>
# no output

wc -l <045 product files plus builtinModelDescriptors.ts>
# all at most 229 lines; largest kimiFiles.test.ts
```

## Remaining concerns

- 045 未触碰范围外的退役模型测试夹具；它们仍归后续 055 清理。
- 未调用真实 Kimi endpoint；所有上传、编码与 cleanup 断言均使用注入 fetch，符合任务树约束。
