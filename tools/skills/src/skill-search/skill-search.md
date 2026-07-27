# skill_search

按名称、描述或触发词模糊搜索仓库里已注册的 skills，用来发现「有没有相关的技能指南可读」。

## 何时用
- 拿到任务不确定该按什么套路做时，先搜一把相关 skill（如「图表」「提问」「可视化」）看有没有现成指南。
- 命中后再用 `skill_read` 读取该 skill 的完整正文。

## 参数
- `query`（string，可选）：搜索词，大小写不敏感，按 skill 的名称、描述和触发词做相关度排序。省略或传空字符串会按名称稳定列出全部。
- `limit`（integer，可选，默认 10，最大 50）：限制返回条数。
- 不要传 `skillName`、`name` 或 `pattern`。

## 返回
`{ query, results, total, limit, truncated }`。每个结果除摘要外还带 `score` 和 `matchedFields`，说明相关度及命中的元数据字段。

## 注意
- 只做只读搜索，不会读出正文；要正文请接着调 `skill_read`。
