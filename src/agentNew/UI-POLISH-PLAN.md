# agentNew 界面完善计划（UI Polish）

> 架构师工作法：主会话不写实现码，只维护本文 / 派活 / 验收 / codex review。
> 本文收敛「界面完善」类的小型 UI 轮次（每轮一节），沿用既有契约：U1 UI 只读 atom + 调命令 / U2 命令不收 store / ghost guard / 不可变更新 / 单测先行 / 一文件一职责。

---

## 轮次 1：会话标题（自动取名 + 双击改名）

**现状**：`newSession` 写死「新对话」，之后永不更新；SessionList 把 title 渲染成纯按钮（点击=选中会话）。

### 契约

| # | 契约 |
|---|------|
| TT1 | **自动标题只在标题仍为默认值时触发**：`sendMessage` 时若 `meta.title === '新对话'`（抽常量 `DEFAULT_SESSION_TITLE`），用本条输入派生标题并更新一次。用户改过名（≠默认值）后**绝不覆盖**；同会话后续消息也不再改（届时标题已非默认）。不加 `titleCustomized` 标志位——「用户恰好手动改回『新对话』后又被自动覆盖」这一边角可接受，不值一个持久化字段。 |
| TT2 | **派生规则**：输入压缩空白（`replace(/\s+/g,' ')`.trim）→ 按 **code point** 截前 12 字（`Array.from` 切，防 emoji 断裂）→ 截断则加 `…`。派生为空（理论上 sendMessage 已挡空输入）→ 保持默认名。纯函数 `deriveSessionTitle(input)` 放 commands.ts 内（或独立小文件），可单测。 |
| TT3 | **`renameSession(id, title)` 命令**：照抄 `setWorkspaceRoot` 范式——ghost guard（会话未登记 no-op）+ 不可变更新 + `updatedAt` 前进 + `persistSessions()` 覆盖式落盘。trim 后为空 → no-op（保留原名，编辑框取消语义）；超长入参同样按 code point 截 48 字防爆列表。自动标题内部复用同一条命令（传 id）。 |
| TT4 | **双击行内编辑**（SessionList）：双击标题 → 该行换渲染 `<input>`（本地 useState：`editingId` + `draft`，autoFocus + select 全选）；**Enter / 失焦提交**（调 `renameSession`）、**Esc 取消**；单击行为不变（选中会话）——首击选中、双击进编辑，Finder 同款交互，无冲突。编辑态提交/取消后回到按钮渲染。U1 边界照旧：组件只读 atom + 调命令。 |

### 阶段

- **A 命令层**（先测后码）：`DEFAULT_SESSION_TITLE` 常量（newSession 同步引用）；`deriveSessionTitle` 纯函数 + 单测（压缩空白/12 字截断+…/emoji 不断裂/空入参）；`renameSession` 命令 + 单测（改名/trim 空 no-op/ghost/persist 调用/48 上限）；`sendMessage` 挂自动标题（忙碌守卫之后、runSession 之前）+ 单测（默认名→派生；已改名→不动；第二条消息→不动）。
- **B UI 层**：SessionList 双击编辑（TT4）+ 少量 CSS（`.agentnew-session-rename-input`，对齐现有列表行高）；组件测试（双击出 input 且含原名/Enter 提交调 renameSession/Esc 取消不调/失焦提交）。
- **收口**：`npm run build` + `npm test` 全绿 → `codex review --uncommitted` → 提交。

### 非目标（本轮不做）
- 不做「模型总结生成标题」（LLM 起名）——首条消息截断已够用，成本为零；将来要再议。
- 不做右键菜单/更多会话操作（置顶、归档等）。

> 轮次 1 ✅ 完成（`ad2a96b`）：TT1–4 落地 + codex 修 IME isComposing。npm test 340。

---

## 轮次 2：列表按活跃排序 + 删除确认

**现状**：SessionList 按 `createdAt` 倒序——老会话来新消息不上浮；点 × 直接删（连带持久化），误触即丢。
**事实核查**：`appendItem`/`patchItem` 已收尾 `touchSession` 推 `updatedAt`（R2），`renameSession`/`setWorkspaceRoot` 也推——排序数据现成。

| # | 契约 |
|---|------|
| TU1 | **排序改 `updatedAt` 倒序**（并列时 `createdAt` 倒序兜底，再并列按 id 稳定）。纯 SessionList 改动，与 hydrate 选默认会话的依据（updatedAt 最新）天然一致。 |
| TU2 | **删除两步确认（行内，不用 window.confirm）**：首击 × → 该按钮进入「确认删除」态（变文案/变色，aria-label 同步）；**再击才真删**；失焦 / 鼠标移出该行 / 3s 超时 → 复位。同一时刻至多一行处于确认态（本地 useState：`confirmingId`）。删除仍走既有 `removeSession` 命令，U1 边界不变。 |

阶段：SessionList + CSS + 组件测试（排序断言 / 首击不删且入确认态 / 再击真删 / 移出复位 / 超时复位用 fake timers）→ build/test → codex review → 提交。
