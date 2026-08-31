---
id: "045"
title: 续接 Kimi K3 图片链路
kind: leaf
parent: "200"
depends_on: ["040"]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-31
done: 2026-08-31
base: 98816b041b42d55ee3308a909af8e8cf7f646f36
files:
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/imageCapability.ts
  - packages/agent-ai/src/imageCapability.test.ts
  - packages/agent-ai/src/kimiFiles.ts
  - packages/agent-ai/src/kimiFiles.test.ts
  - packages/agent-ai/src/kimiMessages.ts
  - packages/agent-ai/src/kimiMessages.test.ts
  - packages/agent-ai/src/historyImageCompatibility.ts
  - packages/agent-ai/src/historyImageCompatibility.test.ts
  - apps/web/src/modelInput/providerImageBatch.ts
  - apps/web/src/modelInput/prepareProviderUserInput.test.ts
  - apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.test.tsx
---

# 续接 Kimi K3 图片链路

## 目标

让既有 Kimi 图片事务在 K3 上继续可用。

## 粒度

这是 Kimi 图片上传、消息编码、历史引用与 rollback 的完整事务闭环，预计 15–20 分钟。

## 上下文

现有图片 capability 与校验常量以 K2.6 命名，精确 model guard 也只认 K2.6。K3 官方支持视觉输入，但
不能仅改默认常量后假设一切通过；必须用注入 fetch 证明上传引用仍按 Kimi provider-file 线协议编码，
清理语义不变。全球区仍保持当前明确限制，不能借升级静默放开。

## 覆盖矩阵行

- `C-08`：K3 图片准备、历史消费与失败清理。

## 接口

### 消费

- 040 的 `KIMI_K3_MODEL` 与 K3 descriptor。

### 产出

- 以 K3 命名的图片 capability；现有 `prepareKimiImageBatch()` API 保持兼容。
- K3 descriptor 改为引用新的 capability 名称，不保留 K2.6 生产别名。

## 验收标准

1. K3 图片成功上传后编码为合法 `ms://` 引用，CN scope 与 request region 一致。
2. 部分失败、取消与显式 rollback 都清理已上传文件且最多一次。
3. K3 历史图片可消费；跨 provider/region/非法引用继续降级为 placeholder。
4. Kimi 图片专项测试、类型检查与 diff check 通过，新增/大改文件不超过 300 行。
