# 回退 workspace 文件更改

使用 `revert_workspace_change` 回退先前 `apply_patch`、`write_file` 或 `delete_path` 返回的 `changeSet.id`。

- 先用 `dryRun: true` 检查是否可以安全回退。
- 批量回退时用 `changeSetIds` 按原执行顺序传入；工具会整批预检并逆序原子回退。
- 如果文件在原变更后又被修改，工具会报告冲突且不会改动任何文件。
- 一个 change set 只能恢复到变更前状态；重复调用成功返回 `already_reverted`。
- 该工具可以恢复文件工具记录的文本更改和 `delete_path` 删除的文件或目录。
- 该工具不回退 shell 命令造成的修改；命令行 `rm` 的删除无法撤回。Auto 模式仅对大范围递归强删逐次确认。
