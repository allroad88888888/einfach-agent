# 370 独立审查

结论：**REJECTED**

审查范围：任务 `370-dom-tools.md`、任务索引、实现报告、`370-scope.diff`、`370-delta.diff` 与当前真实源码。按约束未重跑报告声称已通过的测试，未使用浏览器/CDP/真实模型/Keychain，未修改产品或任务文件。

## 发现

### Important

1. ❌ **事件处理中发生取消或目标替换时，复合动作仍继续派发，违反动作前后守卫与“晚到结果不报告成功”的验收。**

   `dom-host.ts:24-25` 只在整个同步 `action` 前（`resolveTarget` 内）和结束后检查 `AbortSignal` / page；`dom-actions.ts:14-24` 的 click 各阶段之间只检查连接性与可操作性，不检查取消；`dom-actions.ts:50-52` 在 `input` handler 返回后无条件向原节点继续派发 `change`；`dom-actions.ts:60-61` 同样在 `keydown` 后无条件派发 `keyup`。因此页面 handler 可以在 `pointerdown`/`input`/`keydown` 中同步取消调用，后续副作用仍会发生。更严重的是，`input` handler 若替换或移除输入节点，代码仍向已脱离的旧节点发 `change`，随后 `result()` 因节点已断开而仅省略 `node`，仍返回 `dispatched:true`；这正是任务要求拒绝的替换身份边界和未知/晚到成功。click 单独做了连接守卫，但 type/key 没有同等保障。应在每个可重入事件阶段后检查 signal、当前 document/page、原 element 的连接与 ownerDocument，并在替换/取消后停止且拒绝结果；补覆盖 handler 内 abort、input 后替换、keydown 后替换的回归。

2. ❌ **disabled 边界只检查目标自身，能点击/输入处于禁用容器内的后代。**

   `dom-visibility.ts:13-15` 仅读取目标元素自己的 `disabled` 或 `aria-disabled`。普通自定义控件常把 `aria-disabled="true"` 放在 option/button 的祖先，而实际被观察和点击的是内部 `span`；当前 `assertActionable` 会放行该 span。原生 `<fieldset disabled>` 中的输入也依赖祖先禁用语义，当前检查同样不完整。任务明确要求 disabled/aria-disabled 不被写；实现已经对 hidden/inert 做祖先遍历，却没有对禁用状态做相应处理。应实现祖先 `aria-disabled` 与原生禁用语义（包括 disabled fieldset/legend 例外），并以点击内部 span、禁用 fieldset 输入验证。

3. ❌ **验收要求的 ARIA combobox 与原生 select 兼容测试没有实际覆盖。**

   报告声称代表性覆盖包含“ARIA combobox state、native input behavior”，但任务第 2 条要求另测 ARIA combobox 与原生 select 原行为兼容。`dom-host.actions.test.ts` 只读取一个静态 `role=combobox` 的 `expanded:false`，没有通过事件 handler 展开/选择/回读；整个 dom 测试集中也没有原生 `<select>` 的读取或动作兼容断言。普通 div dropdown 主路径覆盖良好，但这两项逐条验收仍缺证据。应补最小行为测试，证明 ARIA handler 路径及原生 select 的既有 page 行为未被新包/共享队列破坏。

## 逐条验收

1. ✅ 六工具按固定顺序创建/注册，均有严格 object schema、说明和包装测试；指南给出 read → observed ref → action → read-back，且不把展示文字当底层 value。
2. ❌ 无 ARIA 普通 div、body 弹层、异步出现、搜索过滤、“安全漏洞”选择、显示回读、同名独立 ref 均覆盖；ARIA combobox 和原生 select 的行为兼容测试缺失（Important 3）。
3. ❌ WeakMap/Map 保持同 document ref，未知/移除/替换/过期 page 不按文字重找；隐藏与敏感读取边界基本成立；但祖先 disabled/aria-disabled 可绕过（Important 2）。
4. ✅ 分页、节点/字符/扫描上限明确；过滤会扫描到长页尾部；隐藏祖先/inert、scope 与 body 弹层均有实现或测试。超过 100,000 扫描量明确报错而非伪装无结果。
5. ❌ click 不重复触发且有阶段连接检查；输入派发 input/change，按键说明 synthetic 限制；scroll/wait 有界且 wait 可取消并清 timer；read 无隐式动作。但 handler 内取消与 type/key 的阶段替换没有守卫，仍可继续产生副作用或返回 `dispatched:true`（Important 1）。
6. ❌ DOM 写与 page `fillFields` 确实复用导出的同 Document queue，串行测试存在；但动作内部取消/替换后仍可继续并报告 dispatch，未满足失联或晚到结果边界（Important 1）。
7. ✅ 报告记录 28 files / 71 tests、page/dom build 与类型检查通过；按审查约束未重复执行。源码未见以 `any` 遮蔽类型问题，`git diff --check` 当前通过。
8. ✅ 实现报告包含交付合同、测试结果、显式边界、文件职责与行数，且所有新增源码/测试低于 300 行。

## 严重度汇总

- Critical：0
- Important：3
- Minor：0
