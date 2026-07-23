# browser_action

在对话流里渲染一张**信息卡片**。当前唯一 action 是 `render_card`。

## 参数
- `action`：固定 `'render_card'`。
- `payload.title`（必填）：卡片标题，非空字符串。
- `payload.body`（可选）：卡片正文文本。

## 注意
- **卡片不持久化**：它只是即时的可视化，不会进对话历史。请务必在**最终回复里用文字概括卡片内容**，否则用户刷新后就丢了。
- title 为空 / action 不是 render_card 会直接失败，不产生卡片。