---
id: '070'
title: 宿主关闭后可释放实例并恢复未完成运行
kind: leaf
parent: browser-agent
depends_on: ['010']
discovered_from: '050'
model: gpt-5.6-sol
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files:
  - browser-agent/agent/**
  - packages/agent-core/**
---

# 宿主关闭后可释放实例并恢复未完成运行

## 实际发现与边界

050 的 Chrome 实测在默认 side panel 持有未完成模型 fetch 时关闭窗口：扩展 pagehide 调用 client.dispose()，
browser-agent/agent/src/client.ts 的 dispose 对所有会话调用 core.stopRun，持久化 stopped；重开无法恢复。
直接不 dispose 会让侧栏快速重开时 namespace owner 尚未释放，不能作为可靠解决方案。

010 原有显式 dispose 停止语义保留；本任务新增宿主关闭的可恢复退出方式。它是被050真实消费的生命周期接缝，
不是新增引擎、checkpoint、状态副本、宿主包或通用生命周期框架。050不能直接写core状态或IDB来规避。
本任务仅agent与core范围；050独占extension/embedded/root配置/lock，040及tools均已完成，禁止顺手修改。
本任务拥有覆盖矩阵C17；050在C12消费其结果做真实侧栏验收，060最终核C01–C17。
只可写本任务reports/070-report.md；根账本由编排维护。禁止派子agent、提交、push、远程issue或浏览器自动化。

## 稳定公共合同（产出给050）

```ts
interface BrowserAgentClient {
  dispose(options?: { preserveRecovery?: boolean }): Promise<void>
}
```

- dispose() 和 dispose({preserveRecovery:false}) 保持当前停止并释放的既有语义，所有旧消费者兼容。
- dispose({preserveRecovery:true}) 用于宿主关闭：终止本实例活动执行，保留可以恢复的运行和原有未知工具围栏，
  flush既有持久化队列后释放namespace owner，使同namespace新client可以立即重建。
- 第一次dispose决定关闭方式；重复调用沿用同一Promise，不重复释放或把可恢复状态改写为stopped。
- waiting_user/confirmation等已暂停状态应保留其决策语义；纯模型请求中断可继续，未知外部写入继续reconciliation_required。
- 050消费新合同调用于pagehide；本任务不能修改extension。未完成真实Chrome验证由050继续负责。

## 可复用入口和实现约束

- agent/src/client.ts 已有 mutation队列、closing/disposed、disposePromise、core.persistence.flush/reset和owner.release。
- agent/src/namespaceOwner.ts 使用浏览器Web Locks；Node24也有原生navigator.locks，测试可配fake-indexeddb。
- core/runtime/commands/runLifecycleCommands.ts 的stopRun目前清排队输入、释放内容、标记stopped：不可原样作为宿主暂停。
- 使用既有core command/writer、runAtom、toolCallOutcomes、持久化和recovery guard；若需新增或扩展实例命令，仅暴露实际消费者需要的最小接口。
- 中断必须防迟到结果覆盖：检查toolLoopBootstrap、toolLoopCycle、runToolLoop等abort分支，不使旧循环把interrupted改成stopped/done，
  也不能释放owner后让旧循环继续向持久化写入。不能仅snapshot后恢复原子状态来掩盖异步写回。
- 只标记真正未完成工具，保留既有notStarted/known/unknown事实；未知写不伪造成功回执，不重复执行。
- 等待决策、排队输入、用户附件等在宿主关闭时没有“用户主动丢弃”的授权，不用stopRun的内容释放路径。
- 错误持久化必须可观察且不伪报安全保存；未真正完成flush前不得让并发owner开始覆盖旧状态。
- API key仍只从连接表解析，不能写入运行快照；不改变010的配置冻结/工具权限/双实例隔离合同。
- 遵守CLAUDE.md、.project-lines/SKILL.md相关主线及one-file-one-thing规则。普通新增文件≤300行，复杂例外≤500且说明。

## 验收

1. 真实createBrowserAgent + fake IndexedDB +可控pending fetch：preserveRecovery关闭后signal被取消；
   立即同namespace重建，原会话恢复状态为recoverable，continueRecoveredSession后完成真实请求；旧迟到响应不写回。
2. 双实例A/B：关闭A只取消A，B仍可运行；默认dispose与显式stopRun仍是stopped，不出现恢复按钮。
3. 等待用户/工具确认的会话保留决策；带未知外部写入的会话重建后reconciliation_required，无自动重放。
4. 原compaction中断恢复/timed recovery回归、run abort/guard回归、agent现有测试通过；包括新增测试的TypeScript检查通过。
5. core和agent包build、state/boundaries、docs/diff检查通过；不要无故重跑已通过的全仓6638项，测试范围围绕改动与恢复风险。
6. 更新agent README的默认dispose与宿主关闭方式，报告列出改动、验证命令、实际证据和任何未完成项。

## 审查与后续

- 非转录任务，报告收到后独立sol review；报告reports/070-report.md，审查reports/070-review.md。
- 050可继续与本任务无关的R1拒绝/reload/cancel场景；运行中关侧栏恢复在本任务通过后使用新API复测。
- 060已完成旧默认合同的packed consumer；本任务增加可选方法参数后，060须核实最终正式exports与新关闭合同，不重做无关审计。

- 首次交付DONE，report记录agent21项、core恢复71项及core/agent build/state/boundaries/dist通过；捕获070-scope.diff进入独立review。范围diff包含010已审变更，review聚焦本报告的关闭合同/核心late路径/测试及其直接影响。报告披露组合Vitest invocation出现一次module装载竞态，最终整体门由编排在本次核心变更后复核，不能仅按既有全量日志结案。

- 编排亲验6 files/27 tests（agent/src与runInterruption同次invocation）通过，日志reports/070-parent-test.log。审查待核实真实RecoveryWriteOutcome.status=error的传播，不以flush抛错mock代替driver失败路径。

## R1 独立审查修复

- reports/070-review.md REJECTED：真实recovery writer将driver/capture/stale失败resolve为error outcome，关闭路径丢弃结果仍release owner。检查关闭持久化的durable outcome；error及不安全的skipped/tombstoned不能伪报成功。用真实driver失败通过writer形成error的集成测试，确认dispose拒绝、重复同Promise、namespace不能被第二实例接管；无driver的普通core既有语义须兼容。
- 补真实双client/pending fetch隔离：preserveRecovery关闭A仅取消A，B继续完成；A重建恢复。
- 补fakeIDB重建后的paused decision及unknown fence：至少各一条完整dispose/owner释放/重建链，unknown仍reconciliation_required且无模型或外部工具重放。
- 只修本任务agent/core范围。新测试宜独立聚焦宿主恢复关闭，普通文件≤300行；不得为达行数拆成空壳。修后报告给精确命令与真实结果，先前组合invocation异常不得未经证据称已稳定解决。

- R1交付：agent6 files/25 tests及core9 files/71 tests通过，core/agent build和结构门通过；报告已列精确core命令。范围reports/070-scope-r1.diff，交独立R1复审；编排启动最终全仓test（final-full-test-r1.log）。

- R1独立复审reports/070-review-r1.md PASSED，原Critical/两个Important均关闭；本叶done，C17完成。最终全仓门仍由编排/060收口。
