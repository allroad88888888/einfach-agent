# 010 R2 独立复审

结论：**PASSED**。

R2 已关闭 R1 剩余三项 Important，并补齐初始化阶段 callback 抛错清理与真实 pending fetch 的停止隔离证据。未发现新的 010 自有 Critical 或 Important 阻断。当前全仓 build 的 040 UI 并发类型错误不属于本任务范围；010 包自身构建和本任务定向门已通过。

## R1 剩余阻断复核

### ✅ 配置身份唯一性

- `browser-agent/agent/src/configStore.ts:48-56` 先保留原始 `connectionIdList` / `skillNameList`，再用 `Set` 分别承担引用查询，并对原始数组执行唯一性比较；不再对已去重集合做恒真判断。
- `browser-agent/agent/src/configStore.test.ts:29-47` 将重复 connection ID 与重复 Skill name 直接写入 raw IndexedDB，断言创建失败；随后同 namespace 再创建仍返回原损坏错误，证明失败没有遗留 owner。
- 结论：R1 的实际解码缺陷已关闭。

### ✅ 双 client、三 Agent 与显式会话隔离

- `browser-agent/agent/src/multiClient.integration.test.ts:21-62` 同时创建两个 client、三个 Agent；第一个 client 持有 A/B 两套 endpoint/model/instructions/tool/key，第二个 client 持有 C。三次真实 mock 模型请求逐项校验 URL、Authorization、model、instructions 和唯一工具摘要，两个公开 snapshot 都无 key。
- 同文件 `:65-127` 先选中 B，再显式对 A 执行 undo/redo、answerQuestion、continueRecoveredSession、resumeWithAnswers、confirmTool、stopRun 和 continueInterruptedRun。A 的 tool result、answers、run 状态发生预期变化，B 与另一 client C 的 items/run/answers/artifacts 保持不变。
- 同文件 `:130-174` 让 A 与另一 client C 同时进入真实 pending fetch；active 仍选 B。显式停止 A 后，A 请求 signal 变为 aborted，C signal 保持未中止且 run 仍 running；释放 response 后 A 保持 stopped，C 正常 done。
- 结论：R1 缺失的组合场景以及 R2 追加的真实 AbortController 证据均已补齐。

### ✅ 配置写失败不发布

- `browser-agent/agent/src/configMutation.test.ts:6-35` 通过包内依赖注入令首次 `saveConfig` 确定性失败，断言 mutation reject、snapshot 仍为同一引用且内容不变、listener 零调用；第二次保存成功，snapshot 更新、持久化值正确且 listener 只调用一次。
- `browser-agent/agent/src/client.ts:88-100` 仍保持“持久化成功后才替换 config/snapshot并通知”的顺序，串行 mutation 链在失败后可继续。
- 结论：R1 的未验证项已经转化为确定性行为证据。

## R2 追加要求复核

- ✅ **初始化 callback 泄漏**：`browser-agent/agent/src/client.ts:55-87` 把 `createCore`、宿主 `registerTools`、persistence configure 与 hydrate 放在同一 try/catch；任一步失败都会 reset 已创建 candidate 并释放 owner。`configStore.test.ts:21-27` 令宿主 registerTools 抛错，随后同 namespace 创建成功。
- ✅ **真实运行中 stop 隔离**：multi-client 第三个用例使用两个未决 fetch 和真实 request signals，直接证明只中止显式 A，不影响 active B 或另一 client C。
- ✅ **R1 已通过部分未回归**：实例 persistence、配置 Skill search/read、locked 正向权限、严格 agentProfile codec、dispose flush 与 Web Locks ownership 的代码路径仍保持 R1 审查通过状态；R2 diff 未撤销这些修复。

## 覆盖矩阵判定

- ✅ **C01**：两个 namespace/client 并存，三 Agent 的配置、请求、会话 store、abort registry 和持久化相互隔离；相同 namespace 有 owner 拒绝；配置与会话均有重建证据。
- ✅ **C02**：配置 Skill 进入统一搜索，正文/资源经受 capability 控制的 `skill_read` 按需读取；旧会话重建后仍使用冻结 instructions 与 Skill V1，不读取已编辑 V2。
- ✅ **C03**：同厂商多个 endpoint 同时工作；请求实际捕获 endpoint、model、header 与 prompt。endpoint 随会话冻结，key 按逻辑 connection ID 动态轮换，公开 snapshot 不含 key。
- ✅ **C04**：显式 session resolver 不回退 active；组合测试在选中 B 时实际驱动 A 的发送、停止、确认、问答、恢复、undo/redo，并证明另一 client 不受影响。
- ✅ **C14**：新根与嵌套工具包继续进入 state/boundary/dist 扫描；报告给出 state 26 roots / 1040 files、boundary 1042 files / 9 rules 通过证据。R2 scope 正确排除已交接的 UI、page 和 api 产品源文件。

## 验收标准逐条判定

1. ✅ 两个 client、三个 Agent、同厂商多 endpoint 的真实 mock 请求覆盖 prompt、model、工具目录和 headers；公开 snapshot 无 key。
2. ✅ 配置与已有会话可在 IndexedDB 重建；立即 dispose 后会话仍恢复；旧会话的 instructions/Skill/endpoint 不漂移，key 轮换作用于旧会话；确定性失败写不发布；重复 namespace、损坏/重复身份配置和配置引用规则均有明确实现与证据。
3. ✅ active 切到 B 后，显式 A 的 lifecycle/recovery/undo/redo 都归 A；真实 pending fetch 只中止 A，第二 client C 持续运行并正常完成。
4. ✅ 规定 compact recovery/timing 与 capability 回归通过；browser client 恰好注册一个既有 `compactContextTool`，没有复制压缩引擎，也未清除所有 outcomeUnknown。
5. ✅ 报告记录规定 vitest 命令 36 files / 265 tests 通过；新增测试通过真实模型请求和工具循环证明配置影响运行结果。
6. ✅ `@einfach-agent/browser-agent` build、state、boundaries、docs 与 diff check 均通过；headless 包不依赖 React、DOM 初始化或 Chrome。R2 全仓 build 失败来自并行实施的 040 UI（以及当时尚未修复的 020 文件），不构成 010 自有失败。
7. ✅ 报告列出公共签名、schema 规则、包配置、R2 新增测试及验证命令，内容与当前代码一致。

## 非阻断说明

- Web Locks 的真实浏览器 realm 销毁回收依赖浏览器原语；测试覆盖 manager reject、共享互斥、释放后重开和初始化 callback 抛错后的同 namespace 重建。这一边界已明确记录，不阻断交付。
- 本复审依指示没有重复运行报告已证明的测试，也没有把 040 尚在实施的 UI 类型错误归入 010。

## 回执

**PASSED** — R2 已关闭全部 010 自有阻断，C01/C02/C03/C04/C14 与七项验收均可交付。
