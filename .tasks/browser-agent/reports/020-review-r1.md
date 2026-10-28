# 020 R1 独立复审

结论：**PASSED**

本次对照任务、全局约束、更新报告、`020-scope-r1.diff` 和当前源码静态复核；依要求未重跑已证明通过的测试，也未修改产品代码。

## Findings

### Minor — “adapter 等待中取消”测试已退化为排队开始前取消

- 位置：`browser-agent/tools/page/src/dom-host.identity.test.ts:39-53`
- `fillFields` 现在通过 `enqueueDocumentWrite` 的 Promise continuation 延后启动；测试在调用 `fillFields` 后立即 `controller.abort()`，没有等待 adapter 的 `write` 真正进入。于是操作在 `dom-host.ts:29` 就抛出，`dom-host.identity.test.ts:45` 的 `await waiting` 实际从未执行。该用例不再证明报告所称的“adapter 等待中取消在异步返回后再次检查”。
- 产品实现本身在 `dom-host.ts:40` 的 `await writeResolved(...)` 后紧接 `aborted(ctx)`，静态上仍满足异步 adapter 返回后的迟到结果复核；README/报告也准确说明无法回滚不观察 signal 的第三方 adapter 已产生的副作用。因此此项是负例证据精度问题，不阻断本次验收。
- 建议让 adapter 先发出 entered 信号，测试等待 entered 后再 abort/release，并断言 Promise 为 AbortError、后续字段不写；避免与 `dom-host.r1.test.ts:74-82` 的“排队中取消”重复。

## 原 4 项 Important 复核

1. **宿主级串行：已修复。** `document-write-queue.ts:1-10` 使用 `WeakMap<Document, Promise<void>>` 为同一 Document 共享 FIFO 尾链；前序失败被吞入队尾而调用自身仍保留结果。`dom-host.ts:27-49` 将整个字段批次入队，并在真正进入操作时检查 signal。`dom-host.r1.test.ts:61-82` 覆盖跨两个 host 的调用顺序、失败后继续及排队取消。
2. **adapter 暴露敏感字段：已修复。** `dom-fields.ts:39-47` 在 adapter 匹配前构造已排除 password/hidden 的 `all`，最终候选还做第二次敏感过滤。`dom-host.r1.test.ts:18-23` 用 broad input adapter 验证只返回安全字段。
3. **回读偏离仍成功：已修复。** `dom-host.ts:7-11` 对标量严格比较、对多选使用集合比较；`dom-host.ts:42-45` 在回读不一致时返回 `ok:false`、实际值和明确错误。`dom-host.r1.test.ts:43-59` 覆盖 number 规范化、change handler 回退及多选顺序差异。
4. **adapter 无法接管原生元素：已修复。** `dom-fields.ts:39-47` 先收集 adapter 匹配并从 native 候选排除已适配元素；`dom-fields.ts:50` 和 `dom-write.ts:4-15` 保留原生 disabled/readOnly 强制约束。`dom-host.r1.test.ts:25-41` 覆盖原生 input 接管和 disabled 负例。

## R1 裁决项

- **逐字段检查：通过。** `dom-host.ts:31-46` 在每个字段前依次检查 signal、PageRef/current document、element identity 和当前可写状态；异步写后再次检查 signal、页面、元素身份和可写状态。中途文档失效负例位于 `dom-host.r1.test.ts:85-94`，第二字段保持未写。
- **队列：通过。** 队列按 Document 而非 host 实例共享，符合嵌入场景和 050 接入裁决；一个批次作为原子队列单元保持字段顺序，reject 不堵后续，排队取消在实际写入前拒绝。未引入通用调度框架。

## 验收与覆盖结论

1. 定向套件报告为 7 文件、23 测试通过；原生字段、adapter、部分失败、缺失字段、非法类型和 R1 四项负例齐全，只有上述等待中取消用例时序表达需改进。
2. 独立 core 注册闭环、schema 拒绝及既有 allowlist runtime 证据仍有效。
3. PageRef 失效、DOM 替换、重复标签、调用前/排队取消和中途文档失效均有负例；异步返回后取消由代码复核成立。
4. 报告记录 build 通过；包仍无 Chrome、React 或 Node 运行时依赖，工具和 DOM host 均从根入口导出。
5. README 已同步敏感字段、adapter 优先、Document FIFO、回读比较和外部撤销边界。

- **C05：通过。** 字段读取、敏感排除、原生与显式 adapter、可靠回读、校验及逐字段失败均有实现和证据。
- **C06：通过。** 页面/元素身份、逐字段失效复核、取消检查、Document 级 FIFO 与失败后继续均满足裁决。

未发现 Critical 或 Important 问题。
