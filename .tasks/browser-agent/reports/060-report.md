# 060 独立覆盖审计

状态：**PASSED**。C01–C17 全部有最终实现、行为或门禁证据；未发现未归属的 Critical、Important 或 Minor 产品问题。

## 审计范围与基线

- 规划基线：`953ae7a118eb974e3bb6d134ef65d6fb23c5082e`；核对当前工作树、index、010/020/030/040/050 报告与 review、产品源码、声明/打包产物及保存的门禁日志。
- 本项只写本报告；未修改产品、lockfile 或任务账本，未启动浏览器，未接触系统钥匙串或用户 Chrome。
- 010/020/030/040 的首轮 review 文件仍保留 `REJECTED` 历史结论；最终判定依据各报告的 R1/R2/R3 修正、index 的 done 状态和编排者保存的最终门证据，不误把首轮缺口当成当前缺口。

## 独立 packed headless consumer

结论：**通过**。

从当前 `dist` 对 `@einfach-agent/browser-agent`、`@einfach-agent/tools-browser-page`、`@einfach-agent/tools-browser-api` 及其递归 workspace 发布闭包逐包 `npm pack`，将 workspace 版本改写成对应 packed 版本后，在系统临时目录安装 8 个本地 tarball；只额外安装仓库现有 `fake-indexeddb`。消费脚本只从正式包名导入，未使用 monorepo alias。验证结果：

- Node `v24.14.0`，原生 `navigator.locks.request` 可用；同 namespace 第二个 writer 明确拒绝。
- 两个 namespace、两个同厂商连接实际请求分别到 `https://a.example/v1/chat/completions` 与 `https://b.example/v1/chat/completions`，各自 model、instructions 和 Authorization 值无串线。
- 公开 snapshot 不含 `apiKey`；dispose 后重开 namespace，可恢复 Agent 配置和原 session id。
- page/api 根入口可由 packed ESM 导入；消费树中不存在 `@einfach-agent/browser-agent-ui` 和 `react`。
- 临时 consumer 在每次尝试的 `finally` 中删除。前两次审计脚本分别因未把递归本地 tarball列为顶层依赖、误写 API factory 导出名和未等待异步 run 启动而失败；这些均在隔离临时装配中修正，未发现产品失败。
- 070/050 done 后又从最终稳定的 agent 发布闭包独立打包 6 个 workspace tarball。packed `.d.ts` 含 `dispose(options?: { preserveRecovery?: boolean })`；真实 pending fetch 在 preserve dispose 时收到 abort，同 namespace 重建得到 `recoverable/interrupted_run`，`continueRecoveredSession` 返回 `continued` 并发出第二次模型请求。消费树仍无 UI/React，临时目录已清理。

## C01–C17 矩阵

| ID | 判定 | 实际路径与证据 |
| --- | --- | --- |
| C01 | 通过 | `browser-agent/agent/src/client.ts`、`multiClient.integration.test.ts`；010 R2 覆盖双 client/三 Agent、配置失败恢复和 namespace owner；本审计另以 packed 双 client 验证运行请求隔离、重复 owner 拒绝和重开持久化。 |
| C02 | 通过 | `browser-agent/agent/src/client.ts`、`tools/skills/src/`；010 R2 记录旧 session 的 Skill 正文/资源 V1 冻结、configured Skill search/read 和 allowlist 回归。会话快照复制 Skill 内容而非运行时回读最新配置。 |
| C03 | 通过 | `client.ts`、`configStore.ts`；公开 snapshot 剥离 key，endpoint 编入会话 binding、key 按连接 id 执行时解析。010 测试覆盖 endpoint 冻结/key 轮换；packed 实测同厂商多 endpoint/model/key 隔离。 |
| C04 | 通过 | `packages/agent-core/src/runtime/commands/`、agent 集成测试；显式 session 命令不存在时拒绝而不回退 active session，010 R2 覆盖停止、确认、回答、恢复、undo/redo 和 compaction/timing 回归。 |
| C05 | 通过 | `browser-agent/tools/page/src/`；020 R3 为 8 files/25 tests，覆盖原生字段、adapter 优先、敏感字段排除、真实回读偏离、unsupported、同源 iframe realm。 |
| C06 | 通过 | `dom-host.ts`、`document-write-queue.ts`、`dom-host.r1.test.ts`；按 Document FIFO，覆盖排队取消、已进入 adapter 后取消、DOM/PageRef 失效和重复写入。 |
| C07 | 通过 | `browser-agent/tools/api/src/`；030 R1 为 2 files/17 tests，覆盖搜索/分页/映射/授权、真实 deadline、取消后迟到成功丢弃及固定安全错误。 |
| C08 | 通过 | `browser-agent/ui/src/settings/`、`BrowserAgentView.test.tsx`；040 R1/R2 为 8 tests，覆盖 CRUD、缺失引用、双实例、持久化错误、新建草稿重置；宿主初始化 loading/error 由 README 接入面承担。 |
| C09 | 通过 | `browser-agent/ui/src/chat/`；真实 client 组件测试覆盖配置、发送、工具结果、显式 session 决策命令、undo/redo、recoverable 与 reconciliation-required；文案区分会话撤销与外部页面副作用。 |
| C10 | 通过 | `browser-agent/ui/src/` 与 `browser-agent/ui/reports/040-evidence/`；040 报告记录 360/1040 两档四图、键盘焦点、overflow、console 与样式隔离。当前 `.tasks/.../040-evidence/browser-checks.json` 路径不存在，报告给出的实际路径是产品目录；最终引用应使用后者。 |
| C11 | 通过（Edge 未验证） | `050-review-r1.md` 独立 PASSED；Chrome 151 真实 unpacked MV3、真实 side panel target、权限/目标固定、切 tab、导航/reload 旧 document 失效与显式重绑均有保存 JSON。权限拒绝为真实 core dispatch/定向证据；Edge 未安装，单列未验证。 |
| C12 | 通过 | 050 最终 Chrome 报告记录 pending run 关闭后旧 panel target 消失、新 panel 出现、恢复入口/页面绑定/继续完成三项均 true；embedded 实机记录异步 adapter 已进入、收到 abort、无迟到写入。reload 旧目标为 `unknownResult:true`，无自动重放；070 关闭合同独立 PASSED。 |
| C13 | 通过 | packed 无 UI/React consumer 两轮通过；`embedded-report.json` 记录双 namespace、双 iframe、重复新 session、`cn-city`/`gb-city` 隔离及 controlled adapter 值。050 R1 独立 PASSED。 |
| C14 | 通过 | `pnpm-workspace.yaml`、`tsconfig.app.json`、`scripts/check-boundaries.js`、`scripts/check-dist.js`、state source scope；browser-agent、tools、examples 均进入扫描，headless 规则明确禁 React/UI/Chrome/Node。保存日志：state 28 roots/1055 files、boundaries 1060 files/11 rules、dist 22 packages/32 ESM entries；packed 独立消费通过。 |
| C15 | 通过（fixture 范围） | Chrome 默认 UI 经真实 core/dispatcher/content script 完成 query→read→fill→validate→reload；R1 又让禁用工具、数据源拒绝/API 失败经过真实运行时并可见。模型与业务接口为确定性 fixture，无付费模型或真实客户站点。050 R1 独立 PASSED。 |
| C16 | 通过 | 070 后 `final-full-test-r1.log` 为 834 files passed/3 skipped、6650 tests passed/3 skipped；`final-workspace-build.log`、`final-root-build-r2.log`、`final-state-r1.log`、`final-boundaries-r1.log`、`final-dist-r1.log`、`final-docs.log` 与全树 `git diff --check` 均 exit 0。dist 最终覆盖 22 packed packages、32 个公开 ESM 入口、CSS、NodeNext declarations 与 negative exports。 |
| C17 | 通过 | `client.ts`、`hostCloseRecovery.integration.test.ts`、core run interruption；070 R1 独立 PASSED，覆盖真实 recovery outcome 失败时不释放 owner、默认 dispose 兼容、A/B 隔离、paused payload 重建、unknown external write reconciliation 且不重放。独立 packed 消费进一步验证公开类型、pending abort、重建 recoverable 与继续请求。 |

## 静态边界与失败面

- agent/page/api 生产源码未 import React、UI、Chrome、Node 或 `apps/web`；agent 通过注入 registry 装工具，不依赖 page/api。UI 只依赖 agent/core/react binding，未直接打开 IndexedDB、读取 credential store 或使用 default core。Chrome API 仅在 extension 宿主侧出现。
- 配置 snapshot 只暴露 `credentialConfigured`；模型 key 仅在侧栏运行包内存/IndexedDB 配置与 provider Authorization 组装处使用。content script、service worker、page/api tool args 不携带模型 key；API 工具只接收受限 `sourceId/query/cursor/parameters`，数据源身份和凭据归宿主。
- side panel 正常关闭使用 `dispose({ preserveRecovery: true })` 完成及时交接；恢复安全不只依赖 `pagehide` 异步任务跑完。模型循环前的 `model_run_started` snapshot、外部工具前的 unknown-outcome durable fence 和 hydrate 的 interrupted/reconciliation 归一化共同覆盖 realm 直接消失；Web Lock 随 realm 释放。
- `check-dist` 的发布包枚举包含嵌套 `browser-agent/tools`，并验证 ESM、NodeNext declarations、CSS 和负 export；boundary/state 枚举包含 `browser-agent/examples`。规则是明确正向扫描面与负例，不是路径豁免。
- `browser-agent/` 新增/大改源码和测试最大文件为 `BrowserAgentView.test.tsx` 220 行，均不超过 300 行。基线 diff 中较大的既有 core 测试文件不属于本次新增普通文件；本次相关生产文件也未超过 300 行。

## 最终结论与限制

审计结论：**PASSED**。010–050 与 070 均已独立 PASSED；产品终审 `final-review.md` 也为 PASSED。最终全仓门、真实 Chromium 闭环和两轮独立 packed consumer 互相补足，没有以局部绿测替代组合交付验证。

保留两项明确边界：

1. **未验证环境 — Edge 实机。** 机器没有 Microsoft Edge；已验证 Chromium MV3，不能声称 Edge 已实机验收。
2. **范围限制 — 真实客户站点与真实业务 API。** 没有合同或资料；结论覆盖原生表单、显式 adapter、同源 iframe 和确定性数据源 fixture，不外推到跨源 iframe、关闭 Shadow DOM 或任意站点。
