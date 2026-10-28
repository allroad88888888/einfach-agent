---
id: '050'
title: 扩展和客户自有界面均能完成取数填表闭环
kind: leaf
parent: browser-agent
depends_on: ['010', '020', '030']
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files:
  - browser-agent/extension/**
  - browser-agent/examples/embedded/**
  - browser-agent/README.md
  - package.json
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - tsconfig*.json
  - vite.config.ts
  - scripts/check-boundaries*
  - scripts/state-invariants/sourceScopeTable.js
  - scripts/state-invariants/sourceFiles.test.js
  - scripts/check-dist*
---

# 扩展和客户自有界面均能完成取数填表闭环

## 目标与交付边界

交付可加载的 Chrome/Edge 扩展与不依赖默认 UI 的嵌入示例。两者复用同一个 Agent 配置/运行包和工具包，
验证模型选择、Skill、接口选项查询、表单填充、错误与恢复在实际浏览器中闭环。
此叶负责产品装配与浏览器生命周期，不重写已通过审查的引擎或工具；发现契约不足报告给编排者补派修复。

## 上下文与覆盖

- 新目录而非迁移 apps/web；workspace 与包基座由 010 创建。Chrome 特有类型只出现在 extension。
- 先消费 index 的 createBrowserAgent/BrowserAgentClient、020 的 PageToolsHost/registerPageTools/createDomPageHost、
  030 的 ApiToolsHost/registerApiTools/createApiToolsHost、040 的 BrowserAgentView 与 styles.css。
- 精确接口由依赖实现后编排者同步本任务；不得通过跨包深导入绕过公开合同。
- 覆盖 C11、C12、C13、C15；复核 C03/C04/C06 的装配效果。
- 派发前环境已核实：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` 存在；
  `/Users/dol/Library/Caches/ms-playwright` 有浏览器缓存；未安装 Microsoft Edge。使用独立临时 profile，禁止接管用户浏览器数据。

## 交付内容

1. MV3 manifest、sidepanel 入口、service worker 消息协调、content script DOM 执行、扩展构建与加载说明。
   不依赖 Node server、远程中继或开发服务器维持运行；构建输出可解压加载。
2. 侧栏创建唯一 namespace client，注册页面/API 工具并挂载 UI；配置与运行留在该 client，service worker 不复制状态机。
3. 明确 session→tab→frame/document 的绑定；read_form 不跟随“当前激活 tab”漂移。跨源 iframe 首版明确不支持。
   PageRef.revision 是文档/绑定代次，普通 DOM 更新不递增；字段替换用控件身份另行检查，和页面工具包保持一致。
4. content script 使用 DOM host；消息校验 sender/frame/document、请求关联和结果 schema，不向网页注入模型 API key。
   页面导航或内容脚本重启使旧目标失效，错误回到对应工具调用；页内写锁按 document 串行，多个 session 共用同一锁。
5. cancel/timeout/侧栏退出时停止接收旧调用的写入与结果；运行中丢回执保留未知结果，不靠重发消息“恢复”。
6. 权限以目标页面与配置 API origin 所需范围申请；权限拒绝、受限页面、content script 未连接都有可见错误。
   CSP/CORS/auth 限制不能通过生产环境添加任意代码执行或远程脚本绕过。
7. model 请求留在侧栏的实例 transport；业务查询由明确的 OptionsSource adapter 执行，createApiToolsHost 必须注入
   isSourceAllowed(sourceId, sessionId) 的可信判断。fixture 使用本地固定数据源，
   文档解释客户如何接已有登录态/授权接口，不能把浏览器 cookies 全量复制到其他 origin。
8. 客户示例用普通 DOM 自建最小界面，直接调用 client.core 命令/订阅状态；只依赖 agent+tools，package.json 不含 ui。
   显示两个不同 namespace client，证明不加载 React/Chrome 也能配置、发消息并作用于各自表单。
   嵌入示例作为私有示例 workspace 时注册 `browser-agent/examples/*`，同步 TS 与门禁的精确 src 扫描；不是新增可发布 SDK。
   扩展有真实 src 后移除 010 的临时无源码例外。应用构建产物不伪装成供 Node import 的库入口。
9. 提供本地受控页面与接口 fixture：含依赖父字段的下拉、受控控件、不支持字段、校验失败、权限/请求失败。
   模型请求使用确定性 mock 响应，完整执行真实 core 和 tool dispatch，不拿直接调用工具冒充端到端运行。
   浏览器 E2E 脚本与 Vitest 单测入口明确区分，避免默认全仓 Vitest 误执行 Playwright 测试；不以整目录豁免隐藏生产源码。

## 验收标准

1. `pnpm --filter @einfach-agent/browser-extension build` 产出可加载目录；用独立临时 profile 的 Chromium MV3 浏览器
   实际加载并完成自动化闭环，提供可重跑脚本、浏览器版本及截图。必要测试依赖可在本任务根 package/lock 范围加入。
   Edge 实机加载是单列的发布兼容检查；有环境时运行，无环境时标未验证，不能以 Chromium 成功推定 Edge 成功。
2. 新增 `browser-agent/extension/tests/`：mock 模型→query_options→fill_fields→validate_form→对话完成；
   三个 Agent 的能力/模型配置不同，工具拒绝与失败场景经过真实运行时。
3. 关闭/重开侧栏、刷新页面、切 tab、导航、取消、两个会话同页填充、断开 content script 各有真实浏览器冒烟证据。
   未知写入不自动重放；compaction 中断恢复不被误判为页面写入。
4. `pnpm exec vitest run browser-agent/extension browser-agent/examples/embedded` 与嵌入示例构建通过。
   对打包产物检查 agent/tools 的依赖闭包不包含 UI/React/Chrome，客户使用的 imports 均为正式出口。
5. README 记录加载方式、嵌入最小代码、数据源/组件接入步骤、支持边界、生命周期和真实站点尚未验证的事实。
6. Chromium MV3 与页面闭环证据齐备后才能标开发 done；Edge 未验证必须留在报告和最终兼容范围说明中，
   不据此宣称 Edge 已验收。其他缺口由编排者明确裁决，不擅自扩大目标到后台常驻运行。

## 执行记录

- 2026-09-18派发；报告 `reports/050-report.md`，审查 `reports/050-review.md`。

## 浏览器验证环境补充

- 本机实测 Google Chrome 153.0.8010.50；完整 Chrome for Testing 151.0.7922.34 可用：
  `/Users/dol/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`。
  另有1217缓存147.0.7727.15。优先使用完整测试浏览器和临时profile进行MV3加载，不把headless-shell当扩展宿主。
- Node v24.14.0 内置WebSocket可用于CDP；根尚无Playwright依赖，必要时本任务有权加测试依赖并只更新所需lock条目。
- 自动化必须区分“安装后扩展origin内的sidepanel页面”与“真实浏览器side panel显示”。可先验证前者全链路，但若后者未验证，报告不可写成已验证真实侧栏打开/关闭；必要时用真实用户点击触发sidePanel.open，再检查实际panel target。

- check:dist 当前对所有exports执行Node import；040新增styles.css正式资产出口后，应按出口目标类型区分JS运行入口与CSS资产，CSS验证tar包内文件存在且内容有效，不用Node执行CSS。不可粗暴跳过整个UI包；补此分类的精确回归检查。

## 已交接的 page 合同

- 020已done，完整签名以 browser-agent/tools/page/src/types.ts 与包根export为准，均与本任务PageRef约定一致。
- `createDomPageHost({ document, targetId, documentId?, revision?, controlledAdapters? })`；adapter有kind/matches/read/write/validate?，write收到可信sessionId/signal。
- DOM host按Document共享FIFO，返回逐字段FieldOutcome；多选按集合比较，回读不符即ok:false且value为实际值。bridge无需再造DOM字段锁，但须按请求ID/目标document管理调用与取消。
- 020复审Minor：旧异步adapter取消测试因FIFO微任务变成启动前取消；本任务集成测试应等待adapter实际进入后再取消，证明迟到结果不继续驱动后续工具。

## 已交接的 API 合同

- 030已done；源码公开类型以browser-agent/tools/api/src/index.ts及options-host.ts为准。query_options结果增加可选truncated:boolean（上限100项）。
- `createApiToolsHost(sources, { isSourceAllowed(sourceId, sessionId), timeoutMs? })`，默认10秒，上限120秒，超时参数只能由宿主决定。
- `createFetchOptionsSource({ id, request(input): { url, init? }, mapResponse(payload), fetch? })`；request/map为受信宿主函数，不允许模型提供URL/脚本。Source信号是宿主派生signal，覆盖整个查询含body读取。
- ToolResult错误按稳定code映射包内安全文案，不能依赖自定义ApiToolsError.message显示业务详细错误。

## 装配边界说明

- 默认UI只要求BrowserAgentClient；扩展可在本地装配层用结构兼容的client包装器覆盖createSession，在返回新sessionId前完成目标绑定；不要为此另加host/sdk包。绑定与权限属于扩展宿主，业务模型/API凭据不发给content script。
- 页面绑定持久化只能保存sessionId→目标document标识等宿主信息，不能复制messages/run/checkpoint。恢复后先与实际文档握手校验，tabId存在不等于旧document仍存在；更换绑定须显式用户动作，不能read_form偷跟当前tab。
- 扩展的目标状态栏可在BrowserAgentView外组合，使用公开root/session只读状态得知当前会话并展示目标/授权错误；不往core或UI包塞Chrome API。

## 就绪交接与并行规则

- 010/020/030均已独立审查通过并done；精确运行包签名见index和browser-agent/agent/src/types.ts，page/api公开类型见上方已交接段。
- 040正在补齐UI交互/职责/截图；稳定公开合同仍为BrowserAgentView({client,className?})和styles.css，可在UI实现期间先开发extension桥、目标绑定、客户嵌入与fixture。040独占ui/**，本任务不得修改。
- 裁决：去除050对040的开工依赖，利用已稳定出口并行装配 — 浏览器桥/嵌入部分不依赖UI内部 — 050最终默认界面E2E和done必须等040审查通过，060同时显式依赖040/050，不跳完成门。
- 根package/workspace/lock/TS/Vite/门禁与extension骨架现在由050独占；010不再修改。若需测试依赖，限必要项，不刷新无关解析版本；安装期间提前告诉编排者/UI，避免误报工具暂不可用。
- 生产扩展与嵌入消费正式包出口。需先按依赖顺序构建core/ai/persistence/tools/agent/ui等，不能依赖陈旧dist，也不能仅依赖根Vite源码alias证明packed消费者可用。
- 证据可写reports/050-evidence/；可重跑自动化脚本放本任务测试目录。整体pnpm build等到040类型/声明稳定再最终运行，其在途错误不属于你的产品修复范围。

- 编排静态复查：现check-boundaries的headless规则只扫agent/src且未匹配真实包名@einfach-agent/browser-agent-ui，tools/page|api不受同约束。作为本项新root门禁收口，补运行包/两工具包对UI/React/Chrome/Node的精确禁入与负例，尤其实际UI包名；仍不把ui/extension合法依赖一起禁掉。

- 已查[官方Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)：测试浏览器151支持open(用户手势)、close({windowId})、onOpened/onClosed。可通过扩展页按钮真实打开panel，以事件/target证明生命周期；全局面板关闭用windowId，145+仅tabId且无专属panel会拒绝。

- 020 R3已完成且复审PASSED：支持传入可访问的同源iframe Document，原生识别不依赖parent realm构造器，事件使用ownerDocument窗口；接口不变且已重建dist。

- 用户硬约束：测试浏览器不得访问或写入系统钥匙串；启动必须临时profile+--password-store=basic+--use-mock-keychain，禁止批准钥匙串弹窗/输入密码/查询用户钥匙串。清理仅本次测试临时profile与测试进程，不碰用户日常浏览器。

## 编排集成预检（实现中收口）

- content-script的逻辑documentId与Chrome原生documentId不同，不能直接给tabs.sendMessage的原生documentId选项；按frame路由并在content-script校验不可变逻辑文档身份，或显式获取原生ID，均须真实浏览器验证导航拒绝。
- ExtensionApp目标栏须跟随已展示会话/恢复会话的真实绑定，不能只记录最近新建时的target。导航后提供显式用户重绑路径；不隐式跟随活动tab。核实React.StrictMode的effect重挂不会dispose仍在使用的client。
- embedded重复点击需按新会话从真实query_options结果构造fill_fields参数，mock turn不能耗尽后直接宣称完成；完成文案须等待core run done。两个iframe用不同业务候选值证明API查询实际用于填表。
- 测试扩展从dist复制到自身临时目录后再加入测试权限/harness，不修改正式dist manifest。临时目录分配后所有异常也须finally清理，spawn error明确捕获，进程退出后删除profile。

- 050交付DONE_WITH_CONCERNS，报告reports/050-report.md、范围reports/050-scope.diff；进入独立review，不能跳过此门直接060。
- 限制待独立评估：真实Chrome尚未稳定命中“已进入异步adapter后取消”的时隙，生产host未注入测试慢adapter；020已进入adapter测试+050真实IPC信号测试作为合同联合证据。是否留下具体未验证项由编排在审查后裁决，不冒称实机覆盖。
- 全量test/build与gate成功日志见index，不得重跑已经报通过的命令。审查报告仅reports/050-review.md，禁止改产品/浏览器/钥匙串/远程操作。审查时区分完成后重建client/恢复绑定与关闭侧栏时运行中断恢复，按真实代码证据给结论。

## R1 独立审查修复

- reports/050-review.md REJECTED。Important：readonly/denied mock直接done，没有实际请求禁用工具；API源拒绝/失败也没有通过真实core。补真实运行时发起被禁止fill/query以及已准入query的源授权拒绝/源失败，并断言工具未执行、页面未改、错误安全且可见。不用只检查tools数组替代执行拒绝。
- Important：真实Chrome现缺独立reload场景与取消消息。加入同URL刷新后旧document拒绝、新document显式绑定；取消经真实Chrome消息通道，断言不接受迟到成功或继续后续写。无需声称能精准阻止已经完成的同步字段赋值。
- 编排补充：当前恢复证据要明确区分完成后dispose重建与侧栏运行中断。用可控未完成的mock模型响应，在真实side panel运行中关闭，重开后核对core恢复入口及绑定，再安全继续；避免完成态重建被写成运行中断恢复。
- Minor受控组件和请求失败：同轮用公开controlledAdapters加入独立browser fixture即可（可在embedded测试入口），不必向产品content script硬塞测试后门。可控async adapter场景与真实IPC取消分别证据，报告准确区分。若某项仍无法验证，报具体障碍，不扩大产品抽象来迁就测试。
- 所有测试浏览器继续临时profile+basic/mock-keychain，不碰系统钥匙串或日常Chrome。根全量pnpm test/build已通过，不重复；仅受影响集成测试、必要包build/类型检查和新增实际浏览器场景。最终R1报告/复审要能逐条关闭原发现。
- 宿主初始化错误面：sidepanel入口的createBrowserAgent/bridge.restore失败（另一窗口namespace占用、损坏存储等）应展示用户可读失败与重试，不能只console rejection或空白root。040初始化失败归宿主的合同须在实际扩展兑现；在本叶入口收口，不另加抽象。
- R1运行中关闭发现跨包缺口，已新开070（仅agent/core）：将交付dispose(options?:{preserveRecovery?:boolean})。通过后pagehide消费dispose({preserveRecovery:true})并复测真实侧栏恢复，默认dispose仍停止；本叶不改agent/core、不直接写IDB。其余R1继续，最终done等070独立review通过。
- R1阶段交付NEEDS_CONTEXT：除070外的拒绝/API失败、真实reload/cancel、embedded异步adapter取消和初始化错误面已实现留证，050执行者已停写等待070。为并行收口，独立reviewer可先复核这些已完成项，写050-review-r1-preliminary.md（整体仍等待070和最后侧栏恢复，不提前PASSED）；范围050-scope-r1-preliminary.diff和050-report.md R1记录。

- R1最终接入交付：pagehide使用preserveRecovery，Chrome真实pending请求关闭重开后recoverable/bindingRestored/continued均true。范围050-scope-r1.diff、report已更新，进入最终R1审查；可审查050自身代码/证据，任务done仍等070保存失败R1修复独立通过。

- 编排亲验最终extension/embedded定向2 files/7 tests通过，日志reports/050-parent-r1-test.log。

- R1独立复审reports/050-review-r1.md PASSED；070 R1也已独立PASSED，依赖门解除，本叶done，C11/C12/C13/C15完成。Chrome fixture已验收，Edge/真实客户站点未验证的范围裁决保留。
