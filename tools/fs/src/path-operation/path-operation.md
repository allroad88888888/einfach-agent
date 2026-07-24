# 可撤回地复制或移动路径

`copy_path` 和 `move_path` 只处理当前 workspace 内的相对路径，支持普通文件和目录。

- 目标路径必须不存在，工具不会覆盖文件。
- 符号链接和 `.git` 元数据会被拒绝。
- 成功结果包含 `changeSet`；可交给 `revert_workspace_change`。
- 回退前会校验内容指纹；路径被后续修改时会报告冲突。
