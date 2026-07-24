# skill_search

按名称、描述或触发词模糊搜索仓库里已注册的 skills，用来发现「有没有相关的技能指南可读」。

## 何时用
- 拿到任务不确定该按什么套路做时，先搜一把相关 skill（如「图表」「提问」「可视化」）看有没有现成指南。
- 命中后再用 `skill_read` 读取该 skill 的完整正文。

## 参数
- `query`（string，可选）：搜索词，大小写不敏感，按 skill 的名称/描述/触发词做子串匹配。省略或传空字符串会匹配全部。
- 只接受 `query` 这个字段；不要传 `skillName`、`name` 或 `pattern`。

## 返回
`{ query, results }`，其中 `results` 是命中 skill 的摘要数组（name/description/triggers），可能为空数组。

## 注意
- 只做只读搜索，不会读出正文；要正文请接着调 `skill_read`。
