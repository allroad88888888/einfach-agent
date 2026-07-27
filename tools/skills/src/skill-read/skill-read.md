# skill_read

按精确名称读取某个 skill 的完整 markdown 正文（L2），或读取该 skill 下某个具体资源（L3）。省
略 `resource` 读正文——正文通常会指引接下来该读哪个资源；带上 `resource` 直接读该资源。

## 何时用
- 已经用 `skill_search` 找到相关 skill、需要看它的完整指南时——省略 `resource`。
- 已经读过正文、正文（或上一次 `skill_read` 返回的 `resources` 目录）指引你去看某个具体资源
  （如 `references/evaluation.md`）时——带上 `resource`。
- `name` 必须精确匹配（如 `web-chat-agent`、`planning`），不做模糊匹配；`resource` 同样精确
  匹配，照抄目录里给出的键，不要自己拼路径。

## 参数
- `name`（string，必填）：skill 的精确名称。
- `resource`（string，可选）：该 skill 下某个资源的相对路径（如 `references/evaluation.md`）。省略则读正文。

## 返回
- 省略 `resource`，命中：`{ name, skill, resources }`。`skill` 含
  name/description/triggers/content/resources（content 即完整正文）；顶层 `resources` 与
  `skill.resources` 相同，是该 skill 当前可读的资源键列表，无资源时为空数组。
- 省略 `resource`，未命中：`{ error: "skill not found: <name>" }`。
- 带 `resource`，命中：`{ name, resource, content, truncated }`。`truncated` 为 `true` 时说明
  内容超过 64KB 已被截断，正文末尾会附一行截断说明。
- 带 `resource`，未命中（skill 不存在，或该 skill 没有这个资源键）：`{ error: "..." }`，错误
  文案里包含该 skill 当前可用的资源键列表，据此改用正确的 `resource` 值重试。
- 都不打断循环（TK6），也可结合 `skill_search` 重新发现 skill 名称。