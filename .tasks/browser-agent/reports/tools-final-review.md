# 工具扩充跨包终审

## 结论

**产品实现与覆盖审计：PASSED。** 080、090、100 合并后的跨包增量形成完整闭环，未发现 Critical、Important 或 Minor 级产品问题。T01–T06 均有实现、定向测试、独立审查或 CUA 可见证据支持。

**整树最终验证：PASSED。** 110 已确认两个旧集成测试等待的只是固定时间或请求开始，而没有等待精确 session run 进入终态；测试可能在插件仍 bootstrap 时退出并触发 dispose，形成组合运行中的少请求与未处理动态 import 拒绝。110 仅把两处测试改为有界等待目标 session 的 `runAtom.status === 'done'`，保留原业务断言与默认并发。最终 browser-agent 27 files / 107 tests 全部通过且无 unhandled errors，根 `tsc -b` 与 dist 门也通过。

## 跨包产品审查

- ✅ **页面工具合同与 DOM host**：包根公开 `PageReadInput`、`PageSnapshot`、`ReadTableInput`、`TableSnapshot`，`PageToolsHost.readPage/readTable` 保持可选。完整 DOM host 注册 9 个 page 工具；legacy host 未实现两项读取时仍注册原 3 项和新增 4 个字段工具，没有强制迁移。
- ✅ **页面读取边界**：`read_page` 对正文、表格目录和隐藏祖先使用统一可见性口径，包含关闭 `details` 与 `visibility:collapse` 修正；正文、表格、行列和单元格均有上限。`read_table` 使用元素身份生成稳定 ID，核对 `PageRef`，替换节点后拒绝旧 ID。同源 iframe 测试直接覆盖读取、隐藏过滤、表格快照与替换失效。
- ✅ **字段读取与等待**：`read_field_options`、`wait_for_field` 每次经 `readForm` 复核 PageRef 和字段身份。等待工具为读取本身设置 deadline，传递父取消，并清理 timer/listener；ready/options/value 三类条件及字段替换、挂起读取已有定向证据。
- ✅ **字段写入语义**：`select_option` 严格核对单选/多选形状、重复值及已暴露候选项；`clear_fields` 按当前值类型生成清空值，对不可清空单选逐项失败。两者都标记 `replayUnsafe`、使用串行 `page:write`，并最终走宿主 `fillFields`，因此沿用文档身份、写队列、取消、回读和未知写结果围栏。
- ✅ **API 数据源发现**：`list_options_sources` 仅在 host 支持 `listSources` 时注册。发现过程每次按当前 `sessionId` 重新鉴权，鉴权后分页，只复制 id/label/description，不调用 adapter 或公开请求细节；权限异常使用固定安全错误。090 R1 已恢复原 source 注册条件，未夹带收紧 `query_options` 的既有宿主合同。
- ✅ **扩展协议闭环**：扩展 bridge、protocol、content script 与 service worker 对 `readPage/readTable` 的签名一致；读取仍固定到 session 的 tab/frame/document generation 并走取消路由。`readTable` 发出前校验 PageRef。协议传输失败只对 `fillFields` 标未知写结果，而选择/清空通过同一桥执行，读取失败不会误报为写入未知。
- ✅ **公开消费者**：extension sidepanel、DOM registrar、legacy custom host、preview fixture 与 embedded 示例均通过公开包出口消费。UI 生产依赖未引入具体工具包；fixture 只在 devDependencies 和 Vite alias 中接入，维持可选 UI 边界。
- ✅ **预览隔离与模型可见 catalog**：fixture page host 只绑定同源业务 iframe 的 Document，不可读写 Agent 配置表单；API source 使用固定本地数据，模型 transport 使用固定本地响应。集成测试断言 11 个业务工具加 2 个 skill 工具，并真实调用新增页面/API工具。
- ✅ **兼容与安全边界**：本增量没有新增任意 URL、任意脚本、最终业务提交或凭据导出能力；真实客户站点/API、Edge 和系统钥匙串均未被虚假声称为已验收。

## 覆盖矩阵结论

| 行 | 结果 | 主要证据 |
| --- | --- | --- |
| T01 页面内容/表格 | ✅ covered | 080 R1 的可见性、分页、身份替换与 iframe 跨 realm 测试；080-review-r1 PASSED |
| T02 字段选项/等待/选择/清空 | ✅ covered | 页面包定向测试、registry 兼容测试与 100 preview 真实调用 |
| T03 授权源发现 | ✅ covered | 090 的鉴权后分页、会话隔离、脱敏、legacy host 与发现→查询闭环；090-review-r1 PASSED |
| T04 扩展绑定/身份/取消 | ✅ covered | bridge/protocol/content/service-worker 实现及 target、stale、cancel、未知方法测试 |
| T05 配置页 13 工具与隔离预览 | ✅ covered | `tool-preview.integration.test.ts` 与 `100-browser-check.md` 的原生 Chrome CUA 可见证据 |
| T06 公开包/嵌入兼容 | ✅ covered | package-root imports、extension/embedded 最终重建、legacy host 注册断言 |

账本中 T01–T06 的文字状态仍写作 `pending`，但对应实现叶、独立审查、CUA 与最终组合验证均已通过，证据已齐全。编排者收尾时应将这些覆盖行回写为完成；这属于账本状态同步，不是产品缺陷。

## 验证证据审阅

- 080：页面包 14 files / 38 tests 与 build 通过；R1 可见性和 iframe 读取定向证据通过。
- 090：API 包 3 files / 26 tests 与 build 通过；R1 注册兼容回归通过。
- 100：扩展、预览、两工具包及 embedded 的 20 files / 71 tests 通过；13 项 catalog、隔离 iframe 和新增工具真实调用均有断言。
- 最终静态/构建门：根 `tsc -b`、page R1 后的 extension/embedded build、state、boundaries、docs 均有通过日志。
- 110：定向组合 2 files / 11 tests 通过；默认并发 browser-agent 完整组合 27 files / 107 tests 通过且无 unhandled errors。修正仅等待目标 session 的真实 run 终态，原 endpoint、skill 快照、key 轮换和三 Agent 隔离断言均保留。
- 最终收口：根 `tsc -b` 再次通过；dist 检查通过 22 个 packed packages、32 个公开 ESM 入口、CSS、NodeNext declarations 与负导出检查。
- CUA：原生 Chrome 配置页实际显示 13 个带中文说明的工具及隔离业务 iframe；证据声明范围准确。
- 完整范围 diff 覆盖 55 个文件、812 行新增/58 行删除，并包含未跟踪的新源码与测试；未混入旧 UI 截图 reports。

按终审约束未重跑上述已通过测试。额外只读核对未发现 diff 格式错误。

## 110 收口结论

110 的修正符合终审门：它没有把失败归咎于基线，也没有通过预加载 plugin、mock 内核、禁用并发或放宽断言规避问题。两处旧测试现在等待各自精确 session 的 run 终态，并保留 1 秒上限；若 runtime 卡住或进入非 `done` 状态，测试会报告实际状态并失败。默认并发完整组合已证明原 unhandled errors 随正确生命周期等待消失，因此没有证据表明本次工具扩充引入 runtime 回归。

## Findings

- 产品、覆盖与整树验证：无。
