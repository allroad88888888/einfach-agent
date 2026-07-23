# skill_read

按精确名称读取某个 skill 的完整 markdown 正文，用来在动手前吸收该技能的做法与注意事项。

## 何时用
- 已经用 `skill_search` 找到相关 skill、需要看它的完整指南时。
- 名称必须精确匹配（如 `web-chat-agent`、`ask-user-question`），不做模糊匹配。

## 参数
- `name`（string，必填）：skill 的精确名称。

## 返回
- 命中：`{ name, skill }`，其中 `skill` 含 name/description/triggers/content（content 即完整正文）。
- 未命中：`{ error: "skill not found: <name>" }`，不打断循环，可改用 `skill_search` 重新发现名称。