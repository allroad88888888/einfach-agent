# 浏览器真实能力补强 · 实施计划（PLAN）

> Feature：给 web-agent 接上"浏览器原生就能做到的真实手脚"。
> 范围：Top 2（可视化 echarts + 代码高亮 prismjs）/ Top 3（IndexedDB 持久化 + 多会话）/ Top 4（File System Access 文件工具）。
> 角色：主会话 = 架构师（不写实现代码，只维护本文档 / 派活 / 验收 / 跑 codex review）。

---

## §1 设计契约（不可偏离 · 违反即返工）

1. **纯浏览器**：禁止任何后端 / Node-only API。所有"真实能力"必须用浏览器原生 API（IndexedDB、File System Access、Canvas/echarts、prismjs）实现。
2. **新 agent 工具必须走现有 lazy-tool 架构，不得绕过**：
   - 在 `src/agent/tools/registry.ts` 的 `toolSummaries` 加摘要、`toolSchemas` 加 JSON Schema；
   - 在 `src/agent/runtime/loop.ts` 的 `runRuntimeTool()` 增加真实执行分支，返回 `string`（JSON）；
   - 不在 loop 主流程、组件或别处硬编码工具调用；不破坏"先发 manifest、按需加载 schema"的机制。
3. **失败降级不抛**：工具执行失败一律返回 `formatRuntimeToolError(...)` 的 JSON，绝不 `throw`（`AbortError` 除外，需继续向上抛以支持中断）。沿用现有 fallback 契约。
4. **状态只用 `@einfach/core` atoms**：复用现有 `state/atoms.ts` 的 helper 模式（`appendMessage` / `patchRunState` 风格），禁止引入 zustand/redux/context 自管状态。
5. **不改协议、不重构核心**：不得修改 `ModelAdapter` 协议、`AgentTurnResult` 类型、architect/worker 编排、多轮 loop 结构。本次只做"加法"。
6. **现有 42 个测试必须全绿**；`vite.config.ts` 的 `fileParallelism: false` 不动；`tsc -b` 必须 0 error。
7. **测试先行（TDD）**：每个原子任务先写 vitest（红）→ 再写实现（绿）。浏览器专有 API 在 jsdom 中通过注入/mock 测试，不依赖真实浏览器。
8. **依赖零新增重型库**：`echarts` / `@antv/g2` / `prismjs` 已在 `package.json`，直接用。IndexedDB / File System Access 用原生 API。仅允许新增**测试用**轻量 devDep（且需架构师在 §8 批准）。
9. **优雅特性探测**：File System Access / `showSaveFilePicker` 仅 Chromium → 必须 feature-detect，缺失时返回 error JSON 引导，不报错崩溃。
10. **UI 风格一致**：新样式进 `src/styles/global.css`，复用现有 CSS 变量与类名体系；中文文案。

---

## §2 多 agent 工作流

### 子 agent 选型

| 任务类型 | subagent_type |
|---|---|
| 调研（确认 ai-components Markdown 如何挂 prismjs、echarts 在 jsdom 的测试策略、FS Access 手势约束） | `Explore` |
| 实现（测试先行 + 写代码） | `general-purpose` |
| 跨多文件复杂改动（持久化旁路 + hydrate + 多会话 UI） | `claude` |
| 把某个 P 再拆细 | `Plan` |

### 派活 prompt 模板（每次必含 5 字段）

```
1. 契约：先读 docs/browser-capabilities-PLAN.md §1，逐条遵守。
2. 范围：阶段 Px + 允许改动的文件清单 + 任务编号。
3. 测试先行：先写 vitest → 跑红 → 写实现 → 跑绿，贴红/绿两段日志。
4. 禁止项：本阶段不准碰的文件/不准做的事（防 scope creep）。
5. 产出：改动文件列表 + `npx vitest run <scope>` 末 N 行 + 一句话结论。
```

### 验收清单（架构师亲跑，不只看总结）

- [ ] `git diff` 自己读一遍，改动全部落在派活声明范围内
- [ ] `npx vitest run <scope>` 本地复跑通过
- [ ] `npx tsc -b` 0 error
- [ ] 对照 §1 逐条契约打勾
- [ ] `npm test` 全量 42+ 测试不回归

---

## §3 阶段拆分

> 顺序：**P1 → P2 → P3**。先铺持久化地基，再加独立的文件 / 可视化工具（D1 决策）。

### P1 · IndexedDB 持久化 + 多会话（Top 3）—— 地基

- **P1.1 StorageDriver 抽象**：定义 `StorageDriver` 接口（`load()/save(snapshot)`）。生产实现 `IndexedDbDriver`；测试实现 `MemoryDriver`。放 `src/agent/state/persistence.ts`。
- **P1.2 旁路持久化**：订阅 sessions/messages/timeline/runs atom 变化 → debounce 写库；应用启动时 `hydrate()` 回填 atom。**不改 atom 对外 API**，只做旁路 + 启动注水。
- **P1.3 多会话 UI**：会话列表 + 新建 + 切换 + 删除（复用 `activeSessionIdAtom` / `sessionsAtom`）。
- **测试先行**：driver round-trip（用 MemoryDriver）；hydrate 后 atom 状态正确；切换 session 后消息隔离；新建/删除会话。

### P2 · File System Access 文件工具（Top 4）

- **P2.1 注册工具**：`open_file`（读取用户选定文本文件）、`save_file`（写文本到用户选定位置），runtime 标 `browser`，加 schema。
- **P2.2 执行分支**：在 `runRuntimeTool()` 实现；`feature-detect`（`'showOpenFilePicker' in window`），缺失返回 error JSON；文件内容大时截断预览。
- **P2.3 呈现**：读到的文件名/大小/摘要走现有 timeline `tool` 事件 + 消息呈现。
- **测试先行**：mock `window.showOpenFilePicker` / `showSaveFilePicker` → 工具被调用 → 真实 API 被调 → 结果/错误 JSON 格式正确；feature 缺失时返回降级 error。

### P3 · 可视化 echarts + 代码高亮 prismjs（Top 2）

- **P3.1 `render_chart` 工具**：agent 产出 echarts `option`（JSON）→ 存入新 `chartsBySessionAtom` → 由 `ChartCard` 组件渲染。**只用 echarts**（D3）。
- **P3.2 ChartCard 组件**：`echarts.init` → `setOption` → `resize` → `dispose` 生命周期完整（防泄漏）。
- **P3.3 prismjs 代码高亮**：增强 Markdown 代码块渲染（渲染层增强，非 agent 工具）。
- **测试先行**：`render_chart` 产物入 atom；ChartCard：mount→`init` 调用 / option 变→`setOption` / unmount→`dispose`（遵循 skill 渲染组件用例最小集）/ 错误 option 不抛未捕获错误；prismjs 高亮 class 注入。

---

## §4 测试先行硬性条款

| 阶段 | 必有 vitest 最小集 |
|---|---|
| P1 | driver round-trip · hydrate 正确 · 会话切换隔离 · 新建/删除 |
| P2 | 工具调真实 API（mock）· 结果 JSON 格式 · feature 缺失降级 · 大文件截断 |
| P3 | 工具产物入 atom · ChartCard init/setOption/dispose · 错误 option 不崩 · prism 高亮 class |

跳过"红→绿"过程、直接交实现 + 测试 → **返工**（无法证明测试覆盖实现）。

---

## §5 codex review 用法

- **计划评审**（本轮）：`codex exec` 对抗评审本文档（不依赖 git）。
- **代码评审**（每阶段收尾）：开工前 `git init` + baseline commit（**D2，待用户确认**）后，跑 `codex review --uncommitted`。
- 评审分级：🟥 阻断（契约偏离 / 缺测试 / 安全性能）→ 返工；🟨 建议（命名/可读性/轻微重复）→ 并入下一阶段；🟩 风格 → 记 note。
- 评审意见消化进下一阶段派活 prompt，让子 agent 自动避坑。

---

## §6 风险登记

| ID | 风险 | 对策 |
|---|---|---|
| R1 | IndexedDB 在 jsdom 无原生支持 | StorageDriver 抽象 + 测试注入 `MemoryDriver`，不依赖真实 IndexedDB |
| R2 | File System Access 需"用户手势"（user activation），agent 自动调用 picker 可能被浏览器拒绝 | **D4 待用户拍板**交互方式（见 §8） |
| R3 | echarts 体积大，现 bundle 已 >2.7MB | 接受现状；如需，后续 `dynamic import` 懒加载（不在本次范围） |
| R4 | FS Access / `showSaveFilePicker` 仅 Chromium | feature-detect + 降级 error JSON |
| R5 | 持久化旁路订阅可能与 run 写入频繁交互 → 写库抖动 | debounce + 快照整存；只在 atom 变化后异步写 |
| R6 | 图表产物在 chat 中的呈现位置（消息流 vs 独立面板）影响 UX | 默认绑消息流下方 ChartCard；如有异议 §8 调整 |

---

## §7 进度看板

| 阶段 | 状态 |
|---|---|
| 计划 | **codex 评审中 → 待用户确认** |
| P1 持久化 + 多会话 | 未开始 |
| P2 文件工具 | 未开始 |
| P3 可视化 + 高亮 | 未开始 |

---

## §8 决策日志（含待用户确认）

| ID | 决策 | 状态 |
|---|---|---|
| D1 | 实施顺序 3→4→2（持久化地基先行） | 架构师已定 |
| D2 | 开工前 `git init` + 把现有代码做一次 baseline commit，以支撑 `codex review --uncommitted` 与 diff 验收 | **待用户确认** |
| D3 | 可视化只用 **echarts**，`@antv/g2` 本次不接（避免双库 scope creep，g2 依赖暂留） | **待用户确认** |
| D4 | 文件工具交互方式：(a) agent 直接弹 picker（受 user-activation 限制，可能失败）/ (b) 由 composer 旁按钮在用户手势内选文件喂给 agent + save 同理（更稳） | **待用户确认** |

---

_本文档由架构师维护。每阶段收尾更新 §7，新决策追加 §8。_
