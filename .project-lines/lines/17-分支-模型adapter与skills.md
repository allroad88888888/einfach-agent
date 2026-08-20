# 线：模型 adapter 家族与 skills 三层披露

一句话：两件被同一句口号（「差异挡在一层薄接口后面」）拼在一起、但实际不共享任何代码路径的事——(A) 四家 provider 的私有请求投影收在一张注册表后面；(B) skill 的清单/正文/资源按需披露、两个作用域各自扫描。
类型：分支线——(A) 挂在主线的 `packages/agent-core/src/runtime/modelTurnRequester.ts:183`（`streamModel`）；(B) 挂在主线的 `packages/agent-core/src/runtime/toolLoopBootstrap.ts:133`（`sessionStart` 到点分派）。**结论：这两半应该拆成两条线，理由见文末「判定」。**

## 入口（一个实例从哪开始；引 file:line）

**(A) provider adapter**
- 唯一分发入口：`packages/agent-ai/src/modelAdapter.ts:43` `dispatch()` —— 从 `ModelRequest` 剥出 `settings`/`userId`，剩下的是 provider-neutral 线协议 body。
- 唯一注册表：`packages/agent-ai/src/builtinProviders.ts:215-220` `registerBuiltinProviders`，模块加载即注册四家（:228）。
- 唯一对外桶：`packages/agent-ai/src/index.ts:7-23`，消费方一律 `from '@einfach-agent/ai'`，不深链子模块。
- core 侧的两个调用点：`runtime/modelTurnRequester.ts:183`（流式主循环）与 `runtime/contextDistillation.ts:42`（非流式蒸馏）；子 Agent 另有 `subagents/childModelClient.ts:93`、:172。

**(B) skills**
- 装配：`apps/web/src/main.tsx:145-146`（`configureDefaultSkillsRegistry` + `configureDefaultProjectSkillsProvider`）；CLI 是 `apps/cli/src/runtime.ts:123`、:130-132（它自己用 `node:os` 的 `homedir()` 当用户根，:121）。
- L1 触发：`runtime/toolLoopBootstrap.ts:133` 分派 `sessionStart` 桶 → `tools/skills/src/skill-manifest/skill-manifest.ts:23` 执行 → `timedDispatch.ts:168` 把结果写成一条 `role:'tool'` timeline item。
- L2/L3 触发：模型调 `skill_read`（`tools/skills/src/skill-read/skill-read.ts:58`）。

## 数据怎么走（逐步；每步引 file:line）

### (A) 一次模型请求

1. **core 交出去的东西** → `runtime/modelSettingsProjection.ts:36-38` `modelAdapterSettings`：把会话的 `vendorSettings` 袋子摊平成 `{...袋子, vendor}`，**vendor 最后写**（袋里混同名 key 也改不掉挂靠的 provider）。core 全程不解释袋内任何 key（同文件 :3-4）。
2. **解析谁来执行** → `modelAdapter.ts:45` `defaultProviderRegistry.resolve(settings.vendor)`。未注册的 vendorId 回退到 `fallbackVendorId`（`providerRegistry.ts:111-115`），默认表的 fallback 是 deepseek（`builtinProviders.ts:225`）。连回退目标都没有才抛（`modelAdapter.ts:46-48`）。
3. **厂商私有投影**（唯一允许出现厂商名的文件，`builtinProviders.ts:3-6`）：deepseek 加 `reasoning_effort` + `user_id`（:123-131，四家里唯一消费 `userId` 的）；glm 只加 `reasoning_effort`（:135-137，取值域比 deepseek 多两档，`glm.ts:23` vs `deepseek.ts:52`）；kimi 只加 `region`（:141-143）；openai-compat 原样转发（:146-148）。
4. **adapter 内的净化**：deepseek `prepareDeepSeekRequest`（`deepseek.ts:109-142`）—— thinking 开启时剥掉四个采样参数与 `tool_choice`，并给纯工具调用轮补 `content:''`/`reasoning_content:''`（:94-104，不补会被服务端 400）；glm/openai-compat 只做纯文本降级（`glm.ts:31-34`、`openaiCompat.ts:67-70`）；kimi 换整套 wire item 编码（`kimi.ts:25-39` → `kimiMessages.ts:60-74`，图片块转 `image_url` + `ms://` 引用，五道校验在 :35-52）。
5. **接入点**：deepseek/glm 是模块常量（`deepseek.ts:21`、`glm.ts:18`），kimi 按 region 二选一（`kimiRegion.ts:11-13`），openai-compat **没有默认值**——缺失即 `OpenAiCompatConfigError`，一个请求都不发（`openaiCompat.ts:53-62`）。三层优先级在 `builtinProviders.ts:160-166`。
6. **发出去** → `modelHttp.ts:63-75`（非流式）/ `modelSse.ts:110-150`（流式，`stream:true` 在 :119 注入）。流式还会补 `stream_options.include_usage`：deepseek `deepseek.ts:144-154`、kimi `kimi.ts:61-65`、openai-compat `openaiCompat.ts:72-82`；**glm 显式不注入**（`glm.ts:47` 注明它流末自动返回 usage）。
7. **流式解回统一形状** → `modelSseAccumulator.ts:117-149` `readStreamResponse`：逐 chunk `applyStreamDelta`（:45-49，content/reasoning_content 累加、tool_calls 按 index 拼 arguments，:21-43）→ `toChatResponse`（:51）。没见到 `[DONE]` 就抛 `TruncatedStreamError`（:110-115、:148）。`modelSse.ts:69-99` 还兜住「声明 JSON 实际发 SSE」和反过来的两种错标（:131、:140），非流式响应也会补发一次整包 delta（:141、:148）让上层的 streamWriter 行为一致。
8. **重试**（传输层，四家共享）→ `modelRetry.ts:186-208` `withRetry`：默认 3 次、500ms 起指数退避、带 jitter、上限 20s（:17-22）；只有 `RetriableError` 才重试（:196），`AbortError` 直接透传（:195）。判定在 `requestOnce`（:211-235）：网络异常与 **429/5xx** 可重试（:230），其余 4xx 抛普通 `Error`。`Retry-After` 会被读进退避（:232、:148-158）。**流式一旦吐出过可见 delta 就不再重试**（`modelSse.ts:120-126`、:102）。
9. **重试**（厂商级，只有一家）→ `deepseek.ts:192-256` `streamWithCapacityRetry`：`finish_reason=insufficient_system_resource` 且本轮没吐出任何内容时最多重发 1 次（:54）；`retryObserver` 只有它消费（`providerRegistry.ts:71-76` 的第 4 参）。
10. **错误怎么收尾（"fallback" 的实际落点）** → adapter 一律**抛**（rejected promise），`modelTurnRequester.ts:184-191` 记 trace 后继续抛，`runToolLoop.ts:151-166` 才是终点：`AbortError` → `run.status='stopped'`；其余 → `run.status='error' + safeErrorMessage`。异常从不冒到 React。错误文案先在 `modelRetry.ts:129-138` 被脱敏成 `Chat completion returned <status> (<category>, ...)`，只保留白名单化的 `request_id`/`provider_type`/`provider_code`（:95-127）。
11. **换模型 fallback（只有子 Agent 有）** → `subagents/modelSelection.ts:138-179` `callSelectedSubagentModel`：只在 `tier==='flash'` 且未升过级时升一档，触发条件两个——响应 `finish_reason=insufficient_system_resource` 且无正文（:158-166），或请求失败（:168-178）。`AbortError` 与**确定性 4xx**（400/401/402/422，判据是解析上一步那句状态前缀，:91-96）不升级。

### (B) 一次 skill 使用

1. **扫描根** → `tools/skills/src/projectSkillsLoader.ts:30-33` `SCAN_DIRECTORIES` = `.webAgent/skills` + `.claude/skills`；`:95-114` `collectScanRoots` 把这两个在 workspace 与主目录下各扫一遍 = **最多 4 个根**。主目录恰好等于 workspace 时不扫第二遍（:103，否则同一个 skill 会以两个名字各占一份预算）。
2. **主目录从哪来** → 宿主给：`runtime/userSkillsRoot.ts:27-39` 走桥的 `get_user_home_dir`；没登记桥（纯浏览器）→ `undefined`，只扫工作区（:28）。CLI 绕开它，装配层直接注入 `homedir()`（`apps/cli/src/runtime.ts:129-131`，理由在 :125-128：主目录这个事实由 CLI 产出，反向问桥等于绕一圈问自己）。
3. **列目录** → `projectSkillsLoader.ts:153-165`：`allowExternalPaths: true` **只作用于列出这一个目录**（:158-164 写明理由：桥在 confine 模式下会把根外 symlink 整条滤掉，于是 dotfiles 写法会静默缺席）。只认根的直接子目录——路径必为 4 段（:179-182）。
4. **第三种根：符号链接** → `linkedSkillDirScan.ts:47-105`：把 symlink 条目**自己**当 workspace root 传回桥（:57-63、:79-83，两次都 `allowExternalPaths: false`），目录内文件因此是根内相对路径。链接目标没有顶层 `SKILL.md` 就静默跳过（:73-75）。
5. **一个 SKILL.md → 一条条目** → `packages/agent-core/src/skills/projectSkills.ts:325-418` `buildProjectSkillEntry`（纯函数，零 IO）：frontmatter 只认 name/description/triggers 三个键（:191-213）；name 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`（:39、:296-299）；description 缺失即跳过（:362-367），超 160 字符截断并**留 `…` 标记**（:302-319，理由写在 :304-312）；L3 资源按扩展名白名单过滤（:25-36）、单 skill 上限 32（:16、:386-392）。名字最终是 `` `${scope}/${safeName}` ``（:407）。
6. **多根合成一份快照** → `skills/projectSkillsSnapshot.ts:55-86` `resolveProjectSkills`：**撞名只在同一作用域内裁决**，`.webAgent` 胜 `.claude`（:63-74）；**上限 32 按作用域各算一份**（:20、:77-85，理由在 :17-19）。跨作用域天然不撞名——前缀不同（`projectSkills.ts:48-55`）。
7. **缓存与降级** → `runtime/core/projectSkillsStore.ts:72-104`：缓存键是 **workspaceRoot 不是 sessionId**（:14-15），并发 run 复用同一个 in-flight promise（:75-78）；扫描器整体崩了写一份空快照 + 一条诊断，**绝不冒泡到 run**（:89-97）。
8. **L1 进上下文** → `toolLoopBootstrap.ts:133` 分派 `sessionStart` → `skill-manifest.ts:24-25` `ensure()` 后调 `buildSkillManifestText(snapshot)` → `registry.ts:112-125` 拼文本：内置一段（字节序排序，:95-100 注明不用 `localeCompare`）+ 两个作用域各一段（`:135-150`，两段分开是因为来源可信度不同）→ `timedDispatch.ts:168` 落成 timeline item。**注意：它不在稳定前缀里**（`modelTurnPrefix.ts:79-84` 只有 4 段，`modelTurnPrefix.test.ts:37-43` 明确断言 `buildManifestText` 未被调用）。
9. **L2 正文** → `skill-read.ts:81-173`（扫描来的）/ :200-213（内置）。扫描分支先 `ctx.skills.resolveScannedSkill(name)`（`runtime/toolContext/skillsCapabilities.ts:52-58`）拿到**条目自带的 `rootPath`**，原样传给桥（`skill-read.ts:130-134`，注释写明 `user/` 的路径相对主目录、缺省会当场越界）；读回后剥掉 frontmatter（:166，用的是与解析方**同一个** `splitFrontmatter`，`projectSkills.ts:144`）。
10. **L3 资源**：扫描来的按快照里的白名单查路径，**模型给的字符串永远不参与拼路径**（`skill-read.ts:107-124`、`skillsCapabilities.ts:3-4`）；内置的按 `Record` 精确匹配、不做任何路径规范化（`registry.ts:281-299`，理由在 :272-279：编译期 `?raw` 打包，没有真实文件系统就没有穿越面），超 64KB 截断留提示（:250-266）。
11. **检索兜底** → `skill-search.ts:46-47`：内置与扫描条目并进**同一次**评分（`registry.ts:177-235`，规则只存一份，:169-176 写明分两套必然漂移）。
12. **停用偏好** → `skills/projectSkillPreferences.ts:15` 两个前缀都能被停用，按 workspaceId 保存；`skillsCapabilities.ts:26-28` 在 ctx 构造期过滤一次。

## 每部分负责什么 / 状态归谁 / 谁能调谁

| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `providerRegistry.ts` | vendorId → adapter + 能力描述 | Map（模块内） | `modelAdapter`、装配层 | 认识任何厂商名 |
| `builtinProviders.ts` | 四家的装配、能力表、请求投影 | 4 个 descriptor + 4 个 adapter | 只被 `modelAdapter`/`vendorDescriptor` 经 registry 用 | —（这里是唯一允许写厂商名的地方） |
| `<vendor>.ts` | 一家的净化 + 接入点 + 调用入口 | 模块常量 | 只被自家 adapter 调 | 读 store/atom；解释别家的字段 |
| `modelRetry/modelHttp/modelSse` | 传输、重试、SSE 归一 | 无 | 四家共用 | 认识厂商 |
| `modelAdapter.ts` | 分发 | 无 | core 的 4 个调用点 | 按 vendor 写 if 链 |
| `registry.ts`（skills） | 内置 5 个 skill 的内容 + 清单拼装 + 评分 | 编译期 `?raw` 常量 | 三个工具 + `builtInSkillsRegistry` | import runtime/state/UI |
| `projectSkillsLoader.ts` | 扫描 IO | 无 | 只被 provider 调 | 解析 frontmatter（那是纯函数层的事） |
| `skills/projectSkills*.ts`（core） | 纯函数：解析、卫生化、撞名、上限 | 无 | loader、tool ctx、设置面板 | 任何 IO |
| `projectSkillsStore.ts` | 按 workspaceRoot 缓存快照 | root store 的 `projectSkillsAtom` | `ensure`/`refresh` 命令 | 把扫描失败冒泡给 run |
| `skillsCapabilities.ts` | ctx 上的只读入口 + 白名单 | 构造期取一次的快照副本 | 三个 skill 工具 | 用模型给的字符串拼路径 |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）

**(A) provider 成员 4 个**（`builtinProviders.ts:216-219` 机械可数；`CLAUDE.md` 与 `packages/agent-ai/README.md:3` 都说「三家」，见「文档与代码不一致处」）。
- 精确主形状 **4/4** `{prepare<X>Request, call<X>, stream<X>, <X>ChatRequest extends ChatRequestBase}`。
- 模块级默认接入点常量：**2/4**（deepseek/glm）；kimi 按 region 取（`kimiRegion.ts:11`）；openai-compat **无**（缺失即报错）。
- 必需：`descriptor` + `call` + `stream` 三件套一起注册（`providerRegistry.ts:65-77`）。
- 可选（括号内为实际持有数）：`retryObserver` 厂商级重试（1/4，deepseek）、`userId` 上行（1/4）、`finish_reason` 扩展（1/4，`finishReasonExtensions.ts:13` 目前只转发 deepseek 一家）、图片能力（1/4，kimi）、附属模块（1/4，kimi 独有 `kimiRegion/kimiMessages/kimiFiles/kimiFileDisposal` **4 个**）。
- 能力表计数：`maxTurnTools` 四家**全是 128**；`contextWindowTokens` 兜底 64k/128k/131_072/64k；逐模型表 deepseek **2**、glm **14**、kimi **1**、openai-compat **0**，合计 **17** 条；`imageInput: provider-upload` 全仓**只有 1 条**（`builtinProviders.ts:99-102` 的 kimi-k2.6），其余 16 条走 `textModel()`（:56-58）。

**(B) skills 成员**
- 内置 skill **5 个**（`registry.ts:54-93`）：planning / ask-user-question / tool-loading / web-chat-agent / data-visualization。description **5/5** 都写成「何时用…；何时不用…」（这是模型唯一的选择依据，:11-12）。带 L3 资源的 **1/5**（planning，1 个资源）。`?raw` import 共 **6** 处（5 正文 + 1 资源）。
- `tools/skills/src` 下 4 个子目录里**只有 3 个是工具**（skill-manifest / skill-read / skill-search），`planning/` 是资源目录。
- 工具目录精确主形状（实现 + 测试 + 说明 `.md`）**2/3**：`skill-manifest/` 没有 `.md`——见「另一类」。
- 扫描根：作用域 **2** × 目录 **2** = 最多 **4** 个常规根，外加每个 symlink 条目一个独立根（`projectSkillsLoader.ts:205-217`）。
- 上限：单作用域 skill 数 **32**、单 skill 资源数 **32**、description **160** 字符、frontmatter 读取 **4096** 字节、扫描条目 **2000**、单资源/正文 **64KB**。

## 样板（点名 1–2 个成员 + 为什么：奠基 / 最简 / 最近且干净）

- `packages/agent-ai/src/glm.ts`（59 行）——**最简**。一个 provider 的全部必需部分刚好凑齐一屏：接入点常量、私有取值域类型、请求体类型、一个 `prepare*`、`call*`/`stream*` 两个入口。抄它加第五家，不会顺手抄进 deepseek 的 thinking 净化或 kimi 的 wire 编码。
- `tools/skills/src/skill-search/skill-search.ts`（59 行）——skills 域的**最简**工具样板：`?raw` 引入同目录说明当 `skill.content`、防御式取参、只经 `ctx.skills` 读、不 import 任何 state。

## 加一个（触碰文件；每项标来源：git 配方交集 / 汇合点代码 / 已有清单；不一致处写出）

**加一家 provider**
- `packages/agent-ai/src/<vendor>.ts` —— 来源：汇合点代码（`glm.ts` 全文即模板）。
- `packages/agent-ai/src/builtinProviders.ts` —— 来源：汇合点代码。它自己的头注释（:8-10）声称「新增 provider **只在本文件**加一段 adapter + descriptor 并注册」。**这句只对 core 成立**，宿主侧还有三处，见下。
- `packages/agent-ai/src/index.ts` —— 来源：已有清单（barrel 逐个 `export *`）。
- `packages/agent-ai/src/providerTransport.ts:28-31` —— 来源：汇合点代码。`ProviderIdentity` 是**闭合联合**，只有 3 家；不加就进不了宿主受限传输。
- `apps/web/src/modelTransport/providerRoute.ts:33-75` + `apps/web/src/settings/modelCredentialHost.ts:4-6` —— 来源：汇合点代码。两处都是逐家写死的 if 链/联合。
- 共形测试三份（`providerTextRequest/providerStream/providerRetry.characterization.test.ts`）—— 来源：已有清单。当前 `PROVIDERS` 只有 DeepSeek + GLM 两家，加不加是待确认 #3。

**加一个内置 skill**
- `tools/skills/src/<name>.md` + `registry.ts:54-93` 的 `skillSources` 追一条 —— 来源：汇合点代码。不追等于不存在（清单、检索、读取三条路都从这个数组来）。
- 带资源就再加 `tools/skills/src/<name>/references/*.md` 与 `resources` 字段（planning 是唯一样例，:61-63）。

**加一个扫描目录/作用域**
- `tools/skills/src/projectSkillsLoader.ts:30-33`（`SCAN_DIRECTORIES`）+ `skills/projectSkills.ts:46`（`ProjectSkillOrigin`）+ `:63-66`（`scanRootLabel`）+ `:74-78`（`skillScopeFromName`）+ `projectSkillsSnapshot.ts:30`（`SCOPES`）+ `registry.ts:135-138`（`SCOPE_HEADINGS`）+ `projectSkillPreferences.ts:15`（名字正则）—— 来源：汇合点代码。**7 处**，且 `skillScopeFromName` 的注释（:71-73）明说加 `user/` 那次正是靠它才没漏。

## 标准之外

### 另一类（同目录、不同机制）

- `packages/agent-ai/src/openaiCompat.ts` —— 形状与另外三家相同，但它**不是一家厂商**：没有官方接入点（`:53-62` 缺失即拒）、不做任何私有净化（`:4-10` 逐条列出「不做什么」）、`models` 表故意留空（`builtinProviders.ts:106-115`）、`ProviderIdentity` 里没有它、web 凭证面板里也没有它。今天只有 CLI 装配它并烘焙 baseUrl（`apps/cli/src/runtime.ts:136`（实现在 :65）、`credentials.ts:23-27`）。
- `tools/skills/src/skill-manifest/skill-manifest.ts` —— 三个工具里唯一 `callTiming:'sessionStart'` 的到点工具（:17）。因此模型看不见它，`skill.content` 直接内联一句话（:20），同目录没有 `.md` 说明。`CLAUDE.md` 的「同目录包含实现、说明和测试」对它不适用，这是另一类不是遗漏。
- `packages/agent-ai/src/nonVisualMessages.ts` —— 四家里 **3 家**（deepseek/glm/openai-compat）共用的结构化内容降级；kimi 走自己的 `kimiMessages.ts`。它不是 adapter，是「adapter 之间共享的一段投影」。

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）

- **共形测试只覆盖 2/4 家**：`providerRetry.characterization.test.ts:17-20`、`providerStream.characterization.test.ts:2-3`、`providerTextRequest.characterization.test.ts:2-3` 的 `PROVIDERS` 都只有 DeepSeek + GLM。四家共享同一条 `modelHttp/modelSse/modelRetry` 路径，但只有一半被共形钉住。
- **`packages/agent-core/src/skills/projectSkills.ts` 420 行**，超「普通文件 ≤300」的硬规则。它确实是强内聚的单一职责（一个 SKILL.md → 一条条目），但文件内已用注释分成「常量 / 类型 / frontmatter 解析 / 卫生化 / 条目构建」四段——「解析」与「构建」是两件事，快照合成当年已经拆出去了（`:6-9`），这一层没跟着拆。别模仿，也不必这次动。
- **`finishReasonExtensions.ts:13`** 名为「registry」，实现是直接转发 deepseek 一家（`return deepSeekFinishReasonExtensionFor(reason)`）。加第二家有扩展语义的 provider 时它会当场不够用；今天不是缺陷，是没长出来的注册表。
- **`docs/project-skills-blueprint.md:162`/:252 里的 `ensureProjectSkills`** 在代码里已不存在（全仓 grep 只命中这两行文档）。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）

1. **`openai-compat` 是第四家还是逃生口？**（`builtinProviders.ts:219` vs `providerTransport.ts:28-31`、`apps/web/src/settings/modelCredentialHost.ts:4-6`）：A 它是正式第四家，web/桌面侧只是还没接上——那么「加一家 provider」的清单是 6 处，openai-compat 自己也该补进受限传输与凭证面板；B 它是 CLI/自建网关专用的逃生口，**故意**不进受限传输（受限传输的价值就在于目标白名单，放开就没了）——那么清单只有 3 处，且第五家默认也不进 web。
2. **L1 清单该住哪一层？**（`skill-manifest.ts:17` 的 `sessionStart` 到点工具 + `modelTurnPrefix.test.ts:38` 的断言，vs `docs/skills-tree-blueprint.md:35`/:94 与 `docs/project-skills-blueprint.md:162`/:214 说的「进稳定前缀」）：A 迁移已完成（`a88ba16`），蓝图是陈旧文档，该改的是文档——那么后续 skill 相关内容一律往到点工具这条路加，缓存 epoch 的推理不再牵扯 skills；B 到点工具只是过渡态、仍要迁回前缀——那么现在往 timeline 上加东西就是在加返工量。
3. **共形测试要不要覆盖四家？**（三份 `*.characterization.test.ts` 的 `PROVIDERS` 数组）：A 有意只覆盖 2 家——kimi 换的是整套 wire item 编码、openai-compat 本来就是「不做特化」，共形断言对它们没意义；B 漂移——加 kimi/openai-compat 时忘了扩，而它们四家共用同一条传输路径。答案决定「加一家 provider」的检查表里有没有这三份。
4. **L1 清单的总条数上限有没有人算过？**（内置 5 条 `registry.ts:113-116` + project 32 + user 32，`projectSkillsSnapshot.ts:20`）：A 有意——32 是「一个扫描作用域」的预算，内置不占是因为它们是自家内容，总数 69 可接受；B 上限只按单作用域设计过，69 条是没人算过的合成结果——那么再加第三个作用域时该定的是**总**预算而不是又一个 32。
5. **换模型 fallback 只给子 Agent，是不对称设计还是欠债？**（`subagents/modelSelection.ts:138-179` 有升档，主 Agent 在 `runToolLoop.ts:160-165` 直接 `status:'error'`）：A 有意——主 Agent 换模型是用户没要求的行为，必须显式失败；B 欠债——同一个 `insufficient_system_resource` 在两条路上语义不该不同。答案决定 escalation 是留在 `subagents/` 还是提到共用层。

## 文档与代码不一致处

- `CLAUDE.md`（「`packages/agent-ai/`：DeepSeek/GLM/Kimi 请求…」）与 `packages/agent-ai/README.md:3`（"DeepSeek, GLM and Kimi API adapters"）说**三家**；代码注册**四家**（`builtinProviders.ts:216-219`，文件头注释 :1 自己写的也是「内置四家」）。
- `CLAUDE.md` 说「模型 adapter 的『除 AbortError 外返回 fallback、不向 UI 抛出』是有意契约」；代码里 adapter **一律抛**（`modelRetry.ts:197`、:235、`openaiCompat.ts:56`），把它兜成 `run.status='error'` 的是主循环 `runToolLoop.ts:151-166`。契约成立，但落点不在 adapter。
- `CLAUDE.md` 说 project skills「会被 project skills loader 自动扫描进 L1 清单」，两份蓝图（`docs/skills-tree-blueprint.md:35`/:94、`docs/project-skills-blueprint.md:162`/:172/:214）说 L1 清单**进稳定前缀**；代码里稳定前缀只有 4 段、不含 skills（`modelTurnPrefix.ts:79-84`），清单由 `sessionStart` 到点工具产出成 timeline item（`skill-manifest.ts:17`、`timedDispatch.ts:168`），并有断言钉死（`modelTurnPrefix.test.ts:37-43`）。
- `tools/skills/src/registry.ts:8`、:103-111 的自身注释仍写「全量清单进稳定前缀 / 调用方（modelRun）把它作为稳定前缀的一段发给模型」——同一处漂移在源码注释里也留了一份。
- `docs/project-skills-blueprint.md:162`/:252 引用的 `ensureProjectSkills` 在代码里不存在。
- `tools/skills/README.md:3` 只提「search/read 工具」，漏了 `skill_manifest`。

## 判定：这两半该拆成两条线

**建议拆。** 三条理由，都可机械核对：

1. **无任何代码交界**。`packages/agent-ai` 与 `tools/skills` 之间不存在 import 边（依赖链上前者在 core **之下**、后者在 core **之上**）。两半共用的只有「core 里各有一个注入槽」这件事，而那是装配线的形状，不是本线的。
2. **薄接口的**形状**不同**。provider 是**行为多态**：一张运行期注册表把 vendorId 解析成一对函数，差异在「同一份请求怎么发」；skills 是**内容披露**：一份纯数据快照 + 一个到点工具，差异在「同一份内容什么时候读、从哪读」（编译期 `?raw` vs 文件系统桥）。没有一条断言能同时钉住两者。
3. **变更半径不重叠**。加一家 provider 触碰 6 个文件、全在 `agent-ai` + 三个宿主表；加一个扫描作用域触碰 7 个文件、全在 `tools/skills` + `core/skills`。两张检查表没有交集。

真正共享的只有两条**仓库级**约定，值得记在别处而不是拿它们凑一条线：**「是哪一个」的判定只许有一张表**（`builtinProviders.ts:3-6` / `SCAN_DIRECTORIES` + `skillSources`），以及**未知一律软降级**（未注册 vendor → fallback adapter；扫描崩了 → 空快照，`projectSkillsStore.ts:89-97`）。

拆分建议：`17a-分支-provider-adapter家族`（挂 `modelTurnRequester.ts:183`）与 `17b-分支-skills三层披露`（挂 `toolLoopBootstrap.ts:133`）。

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：58

## 裁决（2026-08-20，dol）

- #1 → **正式第四家**（questions B4）——`openai-compat` 是第四家 provider，web 侧要补上受限传输与凭证面板；「加一家 provider」的清单按 6 处算。
- #2 → **过渡态，最终迁回固定前缀**（questions B3）——负责人原话：「会话开始作为消息发过去，只是告诉 agent 有这些 skills，最终还是要放到请求的固定位」。所以现在往 timeline 这条路上加东西要意识到是临时的；两份蓝图不必改成「到点工具」，反而是**代码要迁回来**。
- #3 → **忘了扩**（questions C5）——三份共形测试的 `PROVIDERS` 要覆盖四家。
- #4 → **上限改 100，不定总预算**（questions C6）——已改（`MAX_PROJECT_SKILLS` 与 `MAX_DISABLED_SKILLS_PER_WORKSPACE` 同步到 100）。理由：进清单的只有 description，塞得下；「这个 skill 在这个项目用不用得上」由启停偏好管，那是用户的选择。启停机制与设置面板（`ProjectSkillsPanel.tsx`）**已存在**。
- #5 → **欠债，提到共用层**（questions A8）——换模型 escalation 不该只有子 Agent 有；同一个 `insufficient_system_resource` 在主/子两条路上语义要一致。
- 另：本线自评应拆成 provider adapter / skills 两条线，负责人尚未表态，保持不拆。
