# ask_user_question

当任务缺少会改变最终方案的关键约束时，不要猜测——用本工具暂停当前 run，向用户提出结构化问题并等待作答。

## 何时用
- 目标范围 / 交互模式 / 技术边界 / 部署环境等关键约束缺失，且合理默认值不够安全时。
- 问题保持少而精：优先问会改变方案的约束；能安全用默认值的就别问，直接在回答里说明默认值。

## 参数
- `id`（string，必填）：本次提问的唯一标识。
- `title`（string，可选）：提问卡片标题。
- `questions`（array，必填，且非空）：问题列表，每项：
  - `id`（string，必填）：问题标识。
  - `text`（string，必填）：问题文案。
  - `type`（必填）：`text` | `single-choice` | `multi-choice` | `confirm`。
  - `options`（string[]，choice 类必给）：可选项。
  - `required`（boolean，可选）：是否必答。

## 行为（重要）
- 参数合法（`questions` 是非空数组）→ **暂停当前 run**，run 状态置 `waiting_user`，等用户在卡片里作答后再继续；本轮不会有普通的 tool 结果回填。
- 参数非法（缺 `questions` 或空数组）→ 返回错误、不暂停，循环照常继续。