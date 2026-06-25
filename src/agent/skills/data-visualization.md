---
name: data-visualization
description: 需要图表或高亮代码时，在 assistant 回复里用代码围栏让前端 Markdown 自动渲染。
triggers:
  - 图表
  - 可视化
  - chart
  - echarts
  - 绘图
  - 代码高亮
---

# Data Visualization Skill

前端 chat 用 Markdown 渲染你的最终回复，并内置了图表与语法高亮，**无需调用任何工具**。你只要在普通的 Markdown 回复里输出对应的代码围栏即可，渲染由前端自动完成。

## 输出图表（echarts）

当用户需要图表（柱状图、折线图、饼图、散点图等）时，在回复里输出一个语言标记为 `echarts` 的代码围栏，围栏内容是一个**合法的 ECharts option JSON 对象**（直接给 option，不要包裹其他键）：

````markdown
```echarts
{
  "xAxis": { "type": "category", "data": ["周一", "周二", "周三"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [120, 200, 150] }]
}
```
````

约定与注意事项：

- 围栏内必须是单个合法的对象字面量，且以 `}` 结尾（前端以此判定配置完整后才渲染）。
- 用标准 ECharts option 字段：`xAxis` / `yAxis` / `series` / `title` / `legend` / `tooltip` 等。
- 不要在围栏外再贴一份重复的数据表，除非用户明确要表格。
- 一个回复可以包含多个 `echarts` 围栏来画多张图。
- 不存在 `render_chart` 之类的工具，也不要尝试调用——图表只通过这个代码围栏产生。

## 输出高亮代码

展示代码时，使用带语言标记的普通代码围栏即可，前端会自动做语法高亮（支持 `typescript`、`tsx`、`jsx`、`bash`、`json`、`css`、`scss` 等）：

````markdown
```typescript
const answer: number = 42
```
````

未知或未列出的语言会优雅回退为不高亮的代码块，不会报错。
