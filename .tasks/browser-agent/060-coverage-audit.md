---
id: '060'
title: 独立验证视图隔离和扩展嵌入全部交付面
kind: leaf
parent: browser-agent
depends_on: ['010', '020', '030', '040']
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files: []
---

# 独立验证视图隔离和扩展嵌入全部交付面

## 目标与交付边界

只读产品代码，独立核查 C01–C17；检查本地工具测试覆盖不到的包依赖、入口、失败态和真实浏览器证据。
本叶只产出审计报告，不修产品；缺口由编排者追加 discovered_from 任务或形成明确裁决。
这是本次视图隔离横切需求的完成门，不把它拆成每个测试命令一个 issue。

## 消费与产出

- 消费 index 的矩阵、公共契约、五个实现叶的 report/review，以及全部 `browser-agent/` 与必要既有 core diff。
- 本审计例外允许读取所有前序报告；不依赖会话历史。基线使用 index 记录的规划基线加实际每叶 base 核对范围。
- 唯一写路径：`.tasks/browser-agent/reports/060-report.md`；独立 reviewer 写 `060-review.md`。
- 报告逐行记录矩阵 id、实际路径、证据、通过/失败/无法核实；区分已有未修回归、本次回归与未验证环境。

## 审计清单

1. 按新包真实入口枚举 Agent/Skill/模型设置、对话、工具等待、恢复、错误与空态，逐项对矩阵，不能只看首页截图。
2. 静态依赖：agent/tools 不依赖 ui/React/Chrome/Node；ui 不直读 credentials/IndexedDB 或 defaultCore；扩展宿主是浏览器 API 的归属。
3. 两个嵌入实例与同厂商多连接隔离、sessions 持久化 namespace、已有会话 instructions/Skill 内容冻结均有真实行为测试。
4. API key 不在配置快照/日志/tool args/content script；工具权限由 core 执行，页面/数据源宿主额外绑定身份。
5. DOM 写入取消/导航/同页并发及未知结果有证据；页面 undo 与会话 undo 的区别准确，不自动重放副作用。
6. 新 workspace、state/boundary/dist 检查确实覆盖嵌套包；负例存在，不能靠路径豁免使测试变绿。
7. 客户示例只安装 agent+tools 能运行；打包导出与声明可消费，组件包样式不污染宿主。
8. 复核 Chromium MV3 的真实加载、侧栏及嵌入证据；Edge 实机发布检查单列通过或未验证，不能混作已经兼容。

## 验收标准

1. 运行最终集成态 `pnpm test`、`pnpm build`，以及 agent/ui/page/api/extension 各自 build。
   若上一叶已在相同最终代码状态运行某项且证据完整，只核对证据，不无故重复耗时测试。
2. `pnpm check:state`、`pnpm check:boundaries`、`pnpm check:dist`、`git diff --check` 全部通过。
3. 抽查一个不安装 ui 的 packed consumer；验证公开 ESM/type imports 与双实例行为，不能只依赖 monorepo alias。
4. C01–C17 无未归属/无证据行；范围外项在 index 有原因与代价；没有真实站点资料时结论只能覆盖 fixture。
5. 全部新增/大改普通源码与测试文件物理行数 ≤300；复杂例外 ≤500 且有单一职责理由。
6. 报告给出每个发现的严重程度、路径、复现与负责叶子；任何功能缺口不得自行标通过。

## 执行记录

- 尚未派发；只报告，不修改产品代码或任务账本。功能 done 由编排者在审计与终审通过后回写。

- 用户硬约束：测试浏览器不得访问或写入系统钥匙串；启动必须临时profile+--password-store=basic+--use-mock-keychain，禁止批准钥匙串弹窗/输入密码/查询用户钥匙串。清理仅本次测试临时profile与测试进程，不碰用户日常浏览器。

## 已有最终门证据（派发时仍需确认050之后改动）

- reports/final-full-test.log：编排pnpm test，833 files passed/3 skipped，6638 tests passed/3 skipped，105.43s。后续若只有050修正，核对定向测试覆盖与变动；不得无故重跑全部。
- reports/final-state.log、final-boundaries.log：编排通过。reports/final-root-build.log：根构建输出，检查最终退出/结尾。
- reports/050-evidence/pnpm-r-build.log、check-dist.log：050执行通过；packed22包/32入口/CSS/NodeNext/negative exports。仍需独立headless consumer核实不依赖UI。

- 根pnpm build复跑已通过（含tsc -b、Web Vite、Server及embed）；成功日志reports/final-root-build-r1.log。首次失败是040 R1测试fixture类型，R2独立tsc与8项定向通过后关闭；不要误读首次失败日志为当前仍失败。

- packed consumer环境：编排实际核实Node v24.14.0，`typeof navigator.locks?.request === "function"`，WebSocket存在、indexedDB不存在。可在临时consumer安装fake-indexeddb用于确定性存储测试，直接用Node原生Web Locks验证打包后的双client；不需要为此启动浏览器或安装UI/React。不得使用monorepo源码alias代替packed正式入口。
- 050最终bridge取消修正后，编排亲验2文件/6项通过，日志reports/050-parent-test.log。完整根build通过后新增的050窄改动，以最终报告/范围diff核实是否需定向tsc。

## 并行开工与最终完成门

- 本项先执行已经稳定的010/020/030/040包边界、packed headless consumer和C01–C10/C14静态审计；这些产品包均已独立审查done，与050的Chrome验收R1没有写路径冲突。临时consumer可放系统临时目录，结束仅清理自身目录；不得修改产品或root lockfile。
- 050当前R1正在补真实运行时拒绝/API失败、reload/cancel和运行中关闭sidepanel恢复。不得重跑050正在执行的浏览器验证，不得把其当前REJECTED报告当最终成功；C11–C13/C15和整体结论必须等待050 R1报告及独立复审done，由编排通知。
- 可先将已完成证据写060报告并发NEEDS_CONTEXT说明等待050最终证据，或短消息告知后等待；不能在050未done时宣称060最终完成。依赖调整只为并行验证已稳定的打包消费者，不削弱全矩阵最终门。
- 不重复已通过的全仓test/build；最终新050窄改动用相应定向证据核对，确有类型或scope变化才补对应检查。060只报告发现，不修代码。
- 050 R1实际发现默认dispose不等于可恢复宿主关闭，新增070产出dispose({preserveRecovery:true})。010原默认语义不变；本任务已完成的packed默认关闭/隔离证据保留。最终结论等待070+050均独立审查done，并核实新关闭合同最终构建出口/恢复证据；不得把旧packed产物当成新API已验证。

- 050 R1和070 R1均已独立PASSED且done；编排最终全仓pnpm test通过：834 files/6650 tests通过，各3跳过，105.05秒，日志reports/final-full-test-r1.log。最终packed新关闭合同由本项执行，build/gates由编排提供新日志；不要把较早6638项日志当最终状态。

- 最终审计交付PASSED，C01–C17均通过；独立packed新增恢复关闭合同和全部最终门均已核实。reports/060-report.md待终审agent独立核对，报告reports/060-review.md。

- 独立reports/060-review.md PASSED，reports/final-review.md整树PASSED；本叶done。未发现新增Critical/Important/Minor，环境/客户范围裁决保留。
