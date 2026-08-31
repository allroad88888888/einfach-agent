# 070 独立审查：审核模型中心边界

## 审查结论

APPROVED。任务范围内的测试补齐了要求的跨层密钥边界回归；执行报告声明的两组验收命令均通过，未发现 Critical 或 Important 问题。

本审查只读取任务文件、执行报告及任务 `files` 对应的范围 diff；未重跑报告已声明的命令，也未审阅生产范围外文件。七个任务文件在基线中均未跟踪，因此按要求以 `/dev/null` 为基线审阅其完整内容。

## 验收标准逐条判定

### ✅ 1. 跨层安全 Vitest 全部通过

执行证据：执行报告记录指定命令通过，结果为 9 个测试文件、87 个测试全部通过。

范围 diff 中可核实的直接断言：

- `connectionProfileProbe.test.ts` 直接构造 `Response(status: 302, location: secret URL)`，断言错误归一为 `upstream-failed`、错误文本不含秘密、fetch 仅调用一次且 `redirect` 为 `manual`。
- 同文件直接断言恰好 1,000 个模型成功、1,001 个失败；200-byte ASCII 模型 ID 成功、201-byte 失败。这里 ASCII 字符的字节数与字符数一致，确实命中了要求的 byte 边界。
- `modelConnectionProfileManifest.test.ts` 直接将根级 `unexpected` 与 `connection.id` 放入拒绝表，并断言统一的“不支持字段”错误；同表还覆盖 `connection.apiKey`、token、Authorization headers 及模型内秘密字段。
- `ModelConnectionProfileSettings.test.tsx` 使用可控 fake `FileReader`，未读取真实文件。合法 manifest 直接断言仅预填 label、规范化 baseUrl、models，输入框与 atom 中的 `apiKey` 均为空；拒绝输入与读取错误均断言编辑表单仍打开并显示通用错误。
- `modelConnectionProfileCommands.test.ts` 覆盖 probe 临时 Key 仅进入调用参数、失败不替换模型、成功或放弃编辑后清空 Key，以及删除所选模型后运行时默认安全回退。
- `ModelCredentialPanel.connections.test.tsx` 覆盖删除整个连接成功后清默认、删除失败保留默认；创建会话仅携带 `connectionId`/model，不含 baseUrl/`apiKey`；静态部署隐藏第三方管理，官方 DeepSeek 与 legacy 分组仍存在。
- `connectionProfileForward.test.ts` 覆盖相同 Base URL 的两个 profile 分别使用服务端各自 Key，并覆盖未知、已删除、缺 Key profile 在上游请求前失败。
- `connectionProfileForwardBinding.test.ts` 覆盖 origin/Key 原子快照绑定及 legacy 无 ID 转发路径。

任务要求重点消化的既有 Minor 均有直接回归，而非仅依赖间接覆盖：3xx 与数值边界、manifest root/id、FileReader 合法/秘密/读取错误均可在范围 diff 中定位。

### ✅ 2. 类型、状态、边界、构建与 diff 门通过

执行证据：执行报告记录 `pnpm exec tsc -b && pnpm check:state && pnpm check:boundaries && pnpm exec vite build --config vite.config.ts && git diff --check` 最终完整复跑通过；首次 TypeScript fake 签名问题修正后也明确重新执行了完整命令链。

报告将 Vite 动静态 import 与大 chunk 警告准确列为既有非失败警告，没有将其伪装成任务内通过项或擅自扩展修改范围。

### ✅ 3. 密钥字面审计结论合理

执行证据：报告声明按任务指定的 `rg -n "apiKey|Authorization|Bearer" apps/web/src/agentNew/ui apps/web/src/settings/modelConnectionProfile*` 执行并逐类审计通过。

结论与扫描范围相符：

- `modelConnectionProfile*` 覆盖 profile host 公共类型、commands 数据流、state atom、manifest 与相应测试，可支持“list/read/probe response、导入结果、持久化 UI atom 不含 Key”的结论。
- 整个 `agentNew/ui` 的扫描包含模型 UI，也会命中独立 MCP Authorization/Bearer 表单；报告明确将这些命中归属到 MCP 配置域，没有误判为模型 profile 泄漏。
- 扫描本身不覆盖 `modelTransport` 或 host-node，故不能单独证明 transport/host 边界；不过报告没有仅依赖该扫描，transport envelope 的无 Key 由组件/session 测试补证，host 的 Key 隔离由 forward 测试补证。综合证据足以支持验收结论。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. `ModelConnectionProfileSettings.test.tsx` 的绑定层秘密样本把 `apiKey` 放在 manifest 根级，而合法 schema 的敏感误植更自然地位于 `connection.apiKey`。因此该 case 与紧随其后的根级 `unexpected` 本质上都走“根级未知字段”路径，未在绑定层精确区分秘密字段拒绝。解析器测试已经直接覆盖 `connection.apiKey`，绑定层也确实验证了含 `apiKey` 文本的文件被通用错误拒绝且不泄漏，所以这是回归样本精度问题，不影响本卡通过；后续可将该样本改为 `{ connection: { ...connection, apiKey: 'secret' } }`。

2. 密钥审计报告按类别汇总命中，没有附逐条 `path:line` 清单。其分类和结论合理，且范围 diff 的直接测试提供了补充证据，但保留原始逐命中表会让终审更容易复核。

## 文件规则

执行报告记录七个任务文件分别为 231、91、219、89、144、91、140 行，均低于 300 行。审阅内容显示每个文件分别聚焦组件连接集成、manifest/FileReader 绑定、profile commands、manifest parser、probe、profile forward、forward snapshot binding，未发现明显职责混杂。
