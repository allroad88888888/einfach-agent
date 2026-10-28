# 260 表单字段标题修复报告

## 结果

`read_form` 现在保留原有显式 ARIA 与原生 label 关系的优先级，并支持控件 `title` 与最近单字段表单项中的可见标题。`name` 和 `placeholder` 仅作为最终回退。因此两个都显示“请输入”的输入框可以分别返回“问题标题”和“问题链接”，就近表单项中的 combobox 也能返回实际标题。

邻近推断只接受以 `form-item` 结尾的容器类或 `role=group`，并要求容器中只有一个顶层字段。多控件行、嵌套 form、多个互相冲突的标题、隐藏标题、错误/状态文本、说明文字和选项标签不会被借作字段名。必填星号与末尾冒号会被清理。

## 改动

- `browser-agent/tools/page/src/dom-field-labels.ts`：独立负责字段标题解析和就近表单项边界。
- `browser-agent/tools/page/src/dom-fields.ts`：字段描述复用新的标题解析器；字段身份、值读取与敏感字段过滤未改。
- `browser-agent/tools/page/src/dom-field-labels.test.ts`：增加真实 DOM 形状及优先级、隔离、清理回归。
- `browser-agent/tools/page/README.md`、`src/read-form/read-form.md`：说明标题来源与保守推断边界。

## 验证

- `pnpm exec vitest run browser-agent/tools/page/src`：15 个测试文件、43 项测试全部通过。
- `pnpm --filter @einfach-agent/tools-browser-page build`：通过，tsup、声明构建及声明说明符修复完成。
- `node scripts/check-docs.js`：646 个 Markdown 文件检查通过。
- `git diff --check -- browser-agent/tools/page .tasks/browser-agent/reports/260-report.md`：通过。
- 新增实现 80 行、测试 44 行，均低于 one-file-one-thing 的 300 行上限；实现文件只负责字段标题解析。

未操作浏览器、钥匙串、extension/network/UI，也未安装依赖、修改 lockfile、提交或推送。
