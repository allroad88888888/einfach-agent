# 035 R1 独立复审：清理探测编辑上下文

## 结论

**APPROVED**。上轮两项 Important 均已修复：旧 probe 的 resolve/reject 在上下文失效后不能回写，`closeSettingsCenter()` 也有直接的 probe idle 回归。

本次只读取更新后的任务文件、执行报告，以及任务列出的四个文件相对指定基线的范围 diff；未重跑执行报告已声明的命令。复审范围严格限定为上轮两项 Important。

## R1 验收逐条判定

### 1. 内部代次阻止旧 probe 回写：✅

- ✅ 代次为非产品状态：`modelConnectionProfileState.ts` 使用 `WeakMap<Store, number>` 保存 generation，未放入 `ModelConnectionProfileEntry`、public profile、transport 或持久化状态。
- ✅ baseUrl 失效：`updateModelConnectionProfileDraft()` 仅在 patch 的 baseUrl trim 后与旧值不同时调用 `invalidateModelConnectionProfileProbe(uiStore)`，随后把 probe 置为 idle；非地址变更和 trim 后相同地址仍不失效。
- ✅ create/edit/close 失效：state 层的 `openCreateModelConnectionProfileEditor()`、`openEditModelConnectionProfileEditor()`、`closeModelConnectionProfileEditor()` 均先递增 generation，再原子写入相应 editor/draft 与 idle probe。成功 save/delete 继续经过 close 路径；`resetModelConnectionProfileState()` 也会失效未完成请求。
- ✅ resolve/reject 均受保护：`probeModelConnectionProfile()` 在请求前捕获 generation；Promise resolve 后和 catch 中都先与当前 generation 比较，不同则返回 false，且不会写 ready/error。
- ✅ 回归证据：命令测试使用可控 pending Promise，分别覆盖 baseUrl 改变与 create 编辑器切换；旧 Promise 完成后均断言返回 false 且 probe 保持 idle。虽然测试使用 resolve，reject 分支在实现中具有同样的 generation guard，证据充分。

### 2. `closeSettingsCenter()` 直接清 probe 回归：✅

- ✅ `SettingsDialog.close.test.tsx` 的 `clears the probe result through closeSettingsCenter` 先打开编辑器并直接建立 `{ status: 'ready' }` probe，再调用实际 `closeSettingsCenter()`，最后通过 `expectEditorClosed()` 直接断言 `probe: { status: 'idle' }`。
- ✅ 同文件的关闭按钮测试也先建立 ready probe，并经 UI 关闭路径断言统一的 editor/draft/probe 清理结果；生命周期仍由既有 state/commands 维护，测试未引入 UI 本地 state 规避。

## 报告门禁核对

- ✅ 执行报告声明定向 Vitest 覆盖两个文件、16 个测试且全部通过；按要求未重跑。
- ✅ 执行报告声明 `pnpm check:state` 与 `git diff --check` 通过；按要求未重跑。
- ✅ 执行报告记录四个范围文件分别为 221、204、219、96 行，均不超过 300 行；范围 diff 与该规模一致。

## 质量发现

### Critical

无。
### Important

无。

### Minor

无。
