# 090 独立审查

结论：**REJECTED**

审查范围：`.tasks/browser-agent/090-api-source-discovery.md`、`reports/090-report.md`、刷新后的 `reports/090-scope.diff`，以及当前磁盘中 `browser-agent/tools/api/**` 的范围内实现、测试和 README。按独立审查约束未重跑执行者已通过的测试，未启动浏览器，未修改产品代码；参考编排者亲验 `090-parent-test.log` 的新工具 8 项通过记录。

## Findings

### Important — source ID 注册校验发生了兼容性变化

任务明确要求“源 id 沿用原校验”且“`query_options` 业务行为不改变”，但 `createApiToolsHost` 的注册条件从基线的 `!source.id.trim() || registered.has(source.id)` 改成了 `!isShortText(source.id) || typeof source.query !== 'function' || registered.has(source.id)`（`browser-agent/tools/api/src/options-host.ts:78-82`）。`isShortText` 还强制 `value.length <= 500`（同文件 `180-182`）。因此，原来可完成宿主注册的 501 字符非空、非重复 source ID 现在会在建 host 时抛 `API_OPTIONS_INVALID_INPUT`；运行时传入缺失/非函数 query 的异常对象也改变了失败时点和错误类型。

这不是 `list_options_sources` 所需的 metadata 限长：任务只要求 `label`/`description` 最长 500，source ID 应沿用既有注册规则。应恢复原注册校验，只对发现结果的可选 metadata 做新限长；若确实要收紧 source ID 或 adapter 的运行时合同，应另行显式迁移，而不能夹带在本兼容增量中。还应补一个回归测试，证明新增发现能力没有改变原 host 对既有合法 source 注册的接受范围。

### Critical

无。

### Minor

无。

## 验收逐项

1. ✅ 公开类型、`ApiToolsHost.listSources?`、`createListOptionsSourcesTool` 均从包入口导出；`registerApiTools` 始终注册 `query_options`，仅在 `host.listSources` 存在时注册发现工具（`query-options.ts:44-47`），legacy host 测试覆盖仅保留原工具。
2. ✅ `listSources` 每次调用按注册顺序逐一以当前 `sessionId` 调用权限闭包，先形成授权列表再分页；默认 20、最大 100、稳定顺序、空列表和 A/B 会话隔离均有实现与断言（`options-host.ts:100-122`；`list-options-sources.test.ts:33-39,52-57,80-83`）。
3. ✅ 输出由 `sourceInfo` 新建，只含 `id`、`label?`、`description?`；可选 metadata 超过 500 字符时省略。测试注入 header、URL 类额外属性并断言不会外泄，也确认发现不会调用 source query（`options-host.ts:166-177`；测试 `41-57`）。
4. ✅ 调用前检查已取消 signal；权限回调异常映射为固定 `API_OPTIONS_FORBIDDEN`，工具层固定安全文案不回显秘密。schema 与 host 直接调用均覆盖非对象、非整数、负数、零、超上限和过大 offset（`options-host.ts:100-112,152-164`；测试 `59-77`）。
5. ✅ 经真实 registry 的发现→查询闭环、权限变更即时反映、分页按授权结果计算、legacy host 兼容均有直接测试证据（测试 `21-39,86-90`）。
6. ❌ source ID 没有沿用原注册校验，且 host 构造行为发生额外收紧，违反明确兼容要求；这是本次拒绝项。共享 `asToolError` 的固定映射与原 `query_options` 映射逐项一致，未发现错误脱敏回归。
7. ✅ 报告记录 API 包 25 项测试、包 build、docs、diff check 全部通过；编排者另亲验新工具 8 项通过。本审查按约束未重复运行。README 已说明发现优先、权限即时性、分页和 metadata 边界。范围内最大源码文件 213 行，新增实现/测试/说明分别为 40/92/7 行，符合本任务文件约束。

恢复 source ID 原注册规则并增加兼容回归证据后再复审。
