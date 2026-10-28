# 线：browser-agent（浏览器内嵌 agent，第二条产品线）

一句话：把同一个 `agent-core` 内核装进一个浏览器扩展的侧边栏，让模型操作**当前绑定的网页**——
不经过本机 Node 后端，能力全部由页面/DOM/网络/API/OCR 五个工具域提供。

类型：分支线——挂在 `browser-agent/agent/src/client.ts:71` 的 `createCore({...})`
（工具家族装配在 `browser-agent/extension/src/sidepanel.tsx:23` 的那一行）。

**它与 00–17 条线的关系**：索引顶部那条 2026-08-20 的"agent 循环跑在服务端"方向裁决
**不覆盖这条线**。`browser-agent` 的循环本来就在浏览器里跑，是它的目标形态，不是待迁移形态。
把 02/12/16 的迁移理由套到它身上会得到反向结论——别这么做。

## 入口（一个实例从哪开始；引 file:line）

- **扩展**（唯一进 git 的装配点）：`browser-agent/extension/src/sidepanel.tsx:15` 的 `void mount()`。
  `:18` 造页面桥 `ExtensionPageBridge`，`:19` 造网络桥（依赖前者），`:20` 造 API host
  （`createApiToolsHost([], { isSourceAllowed: () => false })`——**扩展里默认拒绝全部 API source**），
  `:21` 调 `createBrowserAgent({ namespace: 'extension', registerTools })`。
  生命周期：`:25` `bridge.restore(client.core.sessionIds())` 把已绑定页面恢复回来；
  `:26` 在 `pagehide` 上 `client.dispose({ preserveRecovery: true })`——关面板 = 中断 run 但**保留恢复记录**。
- **无 UI 的嵌入**（客户自带界面）：`browser-agent/examples/embedded/src/main.ts`，
  同样的 `createBrowserAgent` + 自己的 `registerTools`，不依赖 React、不依赖 Chrome API。
- **无模型凭据的夹具**：`browser-agent/ui/tests/fixture.vite.config.mjs`，按 README 的
  `--scenario=configured` 起；它的工具读不到也改不了 Agent 配置表单。
- **模型入口**：不经过宿主分流。`client.ts:163` 建会话时写死
  `settings: { vendor: 'openai-compat', model: agent.model, vendorSettings: { connectionId } }`——
  provider 是**用户自己登记的 openai-compat 连接**，与 `apps/web` 的 DeepSeek/GLM/Kimi 是两套入口。

## 数据怎么走（逐步；每步引 file:line）

1. **命名空间锁** → `client.ts:43` `acquireNamespaceOwner(namespace)`（实现 `namespaceOwner.ts`）。
   同一 namespace 只允许一个 client 活着；`:46` 加载配置失败时先 `owner.release()` 再抛。
   配置库名是 `einfach-browser-agent-config:${namespace}`（`:41`），**一个 namespace 一份库**。
2. **凭据** → `client.ts:56` `createProviderTransportFetch(...)`：从 `config.connections` 里按
   `connectionId` 取 apiKey，塞进 `authorization` 头，再交给 `options.fetch ?? globalThis.fetch`。
   凭据**只活在侧边栏进程内存 + 该浏览器的 IndexedDB**；`client.ts:21` 的 `publicSnapshot()`
   在对外快照里剥掉 `apiKey`（`connections.map(({ apiKey: _key, ...item }) => ...)`）。
3. **内核装配** → `client.ts:71` `createCore({ config, skillRegistry, registerTools })`：
   - `:74` `prepareUserInput: createAttachmentPreparer(...)`——PDF/图片附件，OCR 未配 token 就抛中文错误；
   - `:81` `skillRegistry.list()` = 内置 `builtInSkillsRegistry` + **用户在设置里自己写的 skill**；
   - `:84` `registerTools(registry)`：`:85` 装 `registerSkillsTools` + `compactContextTool` +
     `askUserQuestionTool`，`:86` 装 `registerOcrTools`，`:87` 再交回 `options.registerTools?.(registry)`。
     **注意：没有 shell / fs / git / mcp**——浏览器里没有本机能力，工具面是另选的一套。
4. **持久化** → `client.ts:91` `candidate.persistence.configure({...})`：会话、recovery、historyLog
   **三个 IndexedDB driver**（`einfach-browser-agent-{sessions,history}-<namespace>`），`:98` `hydrate()`。
   没有 SQL 通路，也就不存在 12 线那道"选 driver 的判据"——这条线只有 IndexedDB 一种。
5. **会话创建与工具冻结** → `client.ts:158` `lockSessionCapabilityPolicy(draft, [...])`，
   条目来自该 Agent 的 `toolNames` 与 `skillNames`；`:163` `core.newSession({ capabilityPolicy, agentProfile })`。
   **这是与 `apps/web` 最大的机制差异**：`apps/web` 靠"宿主两态 + `hasHostBridge()`"决定工具可见性，
   而这里靠**会话能力策略在创建时冻结**——同一个浏览器里不同 Agent 看到的工具可以不同，改配置要新建会话。
6. **页面操作** → 工具不自己碰 DOM：`sidepanel.tsx:23` 把 `registry` 交给
   `registerPageTools(registry, bridge)` / `registerDomTools(registry, bridge)` /
   `registerApiTools(registry, apiHost)` / `registerNetworkTools(registry, networkBridge)`，
   实现体在各自包里。桥的实现：`page-bridge.ts`、`network-bridge.ts`、`session-page-host.ts`、
   `tab-targets.ts`、`page-bindings.ts`，跨进程语义由 `protocol.ts` 收口。
7. **扩展进程分工** → `manifest.json`：MV3，`side_panel.default_path = sidepanel.html`，
   `background.service_worker = service-worker.js`（module）。侧边栏持有 client/凭据/run 状态；
   service worker 只做校验与路由；content script 只拿页面操作与不透明 sessionId，**永远拿不到模型 Key**。
8. **网络观测** → `network-main.ts` 在 `document_start` 注入 recorder，`network-bridge.ts` 走
   service worker 转发。README 的边界：只覆盖注入之后、绑定窗口内的 `fetch`/`XMLHttpRequest`，
   默认保留最近 100 条 / 5 分钟；不覆盖 worker、WebSocket、其他 frame。

## 每部分负责什么 / 状态归谁 / 谁能调谁

| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `agent/src/client.ts` | 唯一的装配 hub + 配置 CRUD + 会话创建 | 配置内存副本、快照、mutation 串行队列 | 扩展 / 嵌入方 | 不实现任何页面能力 |
| `agent/src/configStore.ts` | namespace 级配置读写 | IndexedDB 一份 | client | 不校验业务引用关系（那是 client 的活） |
| `agent/src/namespaceOwner.ts` | 单写者锁 | 锁记录 | client | 不管配置内容 |
| `agent/src/attachmentStore.ts` / `prepareAttachments.ts` / `textAttachments.ts` | 按会话存附件，发送前准备 | 附件本体（按 sessionId） | client / OCR 工具 | 不决定何时上传 |
| `tools/page` `tools/dom` `tools/network` `tools/api` `tools/ocr` | 五族能力实现 | 无（host 是注入的） | `registerTools` 槽 | 不 import core 的 store |
| `extension/src/service-worker.ts` | 校验并路由消息 | 无业务状态 | 侧边栏 / content script | 不持凭据 |
| `extension/src/content-script.ts` | 页面侧执行 | 不透明 sessionId | service worker | 不接收模型 Key |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）

- **工具成员形状（必需三件套）**：`browser-agent/tools/<域>/src/<工具名>/` 下
  `<工具名>.ts` + `<工具名>.test.ts` + `<工具名>.md`。与主仓 `tools/` 的"一目录三件套"规则一致
  （例：`tools/page/src/read-page/{read-page.ts,read-page.test.ts,read-page.md}`，
  `tools/dom/src/read-dom/` 同形）。
- **域包形状（必需）**：`package.json` + `src/index.ts`（导出 `register<Domain>Tools`）+ `tsup.config.ts`。
- **计数**：`tools/` 下 23 个工具目录——`page` 9、`dom` 6、`network` 6、`api` 2；
  `browser-agent/README.md` 声明**模型可见 25 个**（page/form 11 + DOM 6 + network 6 + skill 2），
  差额来自 `ocr` 与 skill 工具不走"一工具一目录"。**引用数字时以 README 的 25 为准并注明来源**。
- **`ocr` 是另一类形状**：`tools/ocr/src/` 是 `client.ts` / `result.ts` / `tool.ts` / `index.ts`，
  没有 per-tool 子目录——它是"一个工具 + 一个远端服务客户端"，不是一族小工具。
- **workspace 包**：9 个（agent / extension / ui / api / dom / network / ocr / page / example-embedded），
  全部 `private: true`，已在 `pnpm-workspace.yaml` 的 `browser-agent/*`、`browser-agent/tools/*`、
  `browser-agent/examples/*` 三条 glob 之内。

## 样板（点名 1–2 个成员 + 为什么）

- **`tools/page`** —— 最完整的一族（9 个目录），三件套齐全，`registerPageTools(registry, host)`
  的形状是其余三族的模板。要加页面类工具，抄它。
- **`extension/src/sidepanel.tsx`** —— 唯一进 git 的装配样板，28 行里把"造桥 → 造 client →
  恢复绑定 → 注册一页 onunload 收尾"四件事写全。嵌入方照它写。

## 加一个（触碰文件；每项标来源）

加**一个工具**（同域内）：
1. 新建 `browser-agent/tools/<域>/src/<新工具>/{<新工具>.ts,.test.ts,.md}`（来源：三件套形状，
   4/4 成员一致）。
2. 在 `<域>/src/index.ts` 的 `register<Domain>Tools` 里登记（来源：汇合点代码）。
3. **不改** `client.ts`；只在 Agent 编辑器的工具清单里出现（来源：`client.ts:158` 的能力策略
   取自 `agent.toolNames`，新工具由用户在 Agent 里勾选并**新建会话**才生效）。

加**一个新工具域**：
1. 新建 `browser-agent/tools/<新域>/` 包（package.json + src/index.ts + tsup.config.ts）。
2. 在 `sidepanel.tsx:23` 那一行追加一个 `register<NewDomain>Tools(...)` 调用——
   **这是全仓唯一的域装配点**（`rg 'registerPageTools'` 只命中 sidepanel 与该包自身）。
3. `pnpm-workspace.yaml` 已用 `browser-agent/tools/*` 覆盖，无需改。

## 标准之外

### 另一类（同目录、不同机制）
- `tools/ocr/` —— 见"形状"节。它有一个远端服务客户端 + 固定 host 权限，
  与"操作绑定页面"的另外四族不是同一件事。
- `examples/embedded/` —— 是**消费方样板**，不是可发布成员；它的 `package.json` 明确不依赖
  React、UI 包与 Chrome API。

### 漂移 / 遗留（别模仿，不是"删"）
- `sidepanel.tsx:20` 的 `isSourceAllowed: () => false` 是**扩展形态的故意收紧**（扩展不注册演示
  API source）。嵌入方若要开 API source，必须自己按 sessionId 实现授权，别把这个 `false` 抄走。
- `client.ts:21` 的 `publicSnapshot()` 用对象解构剥 `apiKey`——**新加敏感字段时要回来补这个函数**，
  不补不会报错，只会把新字段漏给 UI。

### 待确认（≤5）
1. **`browser-agent` 要不要进根文档的"主结构"**——本轮已按"进"处理（补 README/CLAUDE.md），
   若负责人的意图是"它是一个独立 subtree，根文档只留一行指针"，那三处改动要缩。两种读法：
   (a) 与 `apps/*`、`packages/*` 平级列全；(b) 只在 layout 末尾加一句"见 browser-agent/README"。
2. **`.tasks/browser-agent/` 的删除是不是有意的**——`90e20ac` 连同任务记录一起删了 28 个 md，
   那些是唯一的实现与验证历史。两种读法：有意（走 issue-tree-workflow 的"完成后归档"）、
   无意（应恢复）。

## 文档与代码不一致处

- `browser-agent/README.md` 说 "twenty-five model-visible tools"，但 `tools/` 下只有 23 个工具目录。
  差额可由 ocr + skill 工具解释，但**没有任何机械证据直接给出 25**——按 README 引用并注明来源。
- 根 `README.md`、`CLAUDE.md`、`docs/README.md` 在本次改动前**完全不提** `browser-agent`，
  而它有 301 个跟踪文件、9 个 workspace 包。已记在 `docs/knowledge-sync-issues.md`。
- `docs/README.md` 与索引都写"桌面端已整条删除（`e52c31d`）"，但 `apps/desktop` 已由
  `bb40e2c` 以 Tauri **薄壳**形式加回（14 个跟踪文件）。薄壳跑的是 `server` 态，
  所以"宿主两态"仍然成立——**过时的是"删除"，不是"两态"**。

## 证据核过：commit `fc2cce0`，2026-10-28；本次打开文件数：14

（2 个全文 `client.ts` / `sidepanel.tsx`，1 个 `manifest.json`，`browser-agent/README.md`，
目录列举 10 次。`browser-agent` 的实现历史 `.tasks/browser-agent/*.md` 已在 `90e20ac` 删除，
无法用 git 配方交集验证"加一个"的第 3 步——那一项来源标的是"汇合点代码"，不是 git 交集。）

## 裁决

（尚无。本轮只做了代码对账，没向负责人提问；上面"待确认"两条等负责人答复后折回本节。）
