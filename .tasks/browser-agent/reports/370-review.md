# 370 R1 独立复审

结论：**APPROVED**

审查范围：`370-dom-tools.md`、任务索引、最新 `370-report.md`、`370-delta.diff`、`370-scope.diff`、R0 审查备份及当前真实源码。按约束未重跑报告声称已通过的测试，未使用浏览器/CDP/真实模型/Keychain，未修改产品或任务文件。

## R0 闭环

1. ✅ **动作阶段取消、替换与晚到结果边界已修复。** `dom-host.ts` 为同一次动作闭包绑定原始 element/ref/page，guard 同时检查 AbortSignal、当前 Document/PageRef、连接状态、ownerDocument 与 ref→element 身份。click 的每个可重入阶段、type 的 input/change、key 的 keydown/keyup、scroll 完成后均调用 guard。测试覆盖 pointerdown handler 内 abort、input handler 替换目标后不发 change、keydown handler 替换目标后不发 keyup。终末 click 允许候选 handler 正常移除自身，但仍检查取消与页面绑定，符合弹层选项点击的真实行为。
2. ✅ **继承 disabled/aria-disabled 与 fieldset 语义已修复。** `isDisabled` 遍历祖先，处理 `aria-disabled`、原生 disabled 祖先和 disabled fieldset，并保留首个 legend 子树的 HTML 例外。测试覆盖 aria-disabled 容器内 span、disabled fieldset input 以及 legend 例外。
3. ✅ **ARIA combobox 与原生 select 行为兼容证据已补齐。** 新测试完成 ARIA 展开→读取候选→选择→显示回读，并通过既有 page host 验证原生 select 的 value/change，再由 DOM host 回读 value/name。

## 补充点击序列核验

✅ 使用目标 document realm 的 `PointerEvent`（可用时）并设置 `pointerType:'mouse'`；序列为 pointerdown → mousedown → 条件 focus → pointerup → mouseup → 单次 click。mousedown 被取消时不 focus，但仍只完成一次 click。各页面可重入阶段之间均有身份/取消/页面/actionable 守卫。对应事件顺序、pointerType、focus 允许与取消均有测试。

## 逐条验收

1. ✅ 六工具按固定顺序创建并可注册，严格 schema、指南、实现和包装测试齐全；指南明确观察 ref 后动作并回读业务状态。
2. ✅ 普通无 ARIA div/span、body 弹层、异步出现、搜索过滤、“安全漏洞”选择、显示回读、同名独立 ref 均覆盖；ARIA combobox 与原生 select 兼容行为已补测。
3. ✅ 同 document ref 稳定；未知、移除、替换、过期 page 均拒绝且不按文字重找；hidden/inert、disabled/aria-disabled/fieldset、readonly、password/hidden input 与安全属性边界完整。
4. ✅ 分页及字符、节点、扫描工作量有界；过滤扫描可到长页末尾；隐藏祖先、inert、scope、字段容器和 body 弹层路径符合合同。
5. ✅ click 遵守完整事件序列并仅触发一次 click，取消/身份/页面守卫覆盖各可重入阶段；输入派发 input/change 并回读；键盘文档明确 synthetic 限制；scroll 有回读；wait 可取消、有截止时间并清理 timer；read 保持只读。
6. ✅ DOM 写与 page `fillFields` 复用同一 Document queue 并有串行测试；handler 内取消、替换与页面失联不会继续后续阶段或报告成功。
7. ✅ 报告记录最终 `29 files / 76 tests`、page/dom build、dom 类型检查与根 tsc 通过；按复审约束未重复执行。未见以 `any` 掩盖类型问题；当前相关范围 `git diff --check` 通过。
8. ✅ 报告已更新 R1 闭环、文件职责、行数、验证结果与显式边界；所有新增源码/测试低于 300 行。

## 严重度汇总

- Critical：0
- Important：0
- Minor：0
