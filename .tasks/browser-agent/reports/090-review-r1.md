# 090 R1 独立复审

结论：**PASSED**

审查范围：`.tasks/browser-agent/090-api-source-discovery.md` 的 R1 修正、更新后的 `reports/090-report.md`、刷新后的 `reports/090-scope.diff`，以及当前磁盘中 `browser-agent/tools/api/**` 的相关实现与测试。只读产品，未启动浏览器，未重跑报告中已通过的测试。

## 上轮发现复核

### ✅ Important：source ID 注册校验兼容性已恢复

`createApiToolsHost` 的注册条件已恢复为基线原实现：仅拒绝 trim 后为空或重复的 source ID（`browser-agent/tools/api/src/options-host.ts:78-82`）。R1 删除了上一轮新增的 `isShortText(source.id)` 长度限制和 `typeof source.query` 运行时检查，因此发现功能不再收紧 host 初始化合同。

新增回归测试使用 501 字符 source ID，确认 host 仍可按旧合同构造，同时 `queryOptions` 继续在原有输入校验阶段返回 `API_OPTIONS_INVALID_INPUT`（`browser-agent/tools/api/src/options-host.test.ts:32-37`）。这准确保留了原失败时点，也把发现 metadata 的 500 字符边界与 source ID 的既有合同分开。

## 验收逐项

1. ✅ 公开类型、可选 `listSources` 与 `createListOptionsSourcesTool` 均导出；注册器只在 host 提供 `listSources` 时增加新工具，legacy host 保持仅注册 `query_options`。
2. ✅ 每次调用按当前 session 逐项鉴权，授权完成后分页；默认 20、最大 100、稳定注册顺序、权限即时变化、A/B 会话隔离及空列表均有直接实现和测试证据。
3. ✅ 返回对象仅复制 `id`、`label?`、`description?`，可选 metadata 最长 500；额外 URL/header/credential/adapter 属性不会进入结果，发现过程不调用 query 或网络。
4. ✅ 调用前取消检查、schema 与 host 直接调用的 offset/limit 非法值检查，以及权限异常固定文案脱敏均有覆盖。
5. ✅ registry 内发现→查询闭环、授权后分页、legacy 兼容有直接测试证据。
6. ✅ R1 恢复原 source 注册校验；`query_options` 输入验证、查询 deadline、错误固定映射和业务行为未改变。上一轮唯一阻断项关闭。
7. ✅ 报告记录 R1 后 API 包 3 files / 26 tests、包 build、docs 与 diff check 通过；本复审未重复运行。README 和中文工具说明覆盖调用顺序、分页、授权与保密边界，文件职责和行数符合任务约束。

## Findings

- Critical：无。
- Important：无。
- Minor：无。
