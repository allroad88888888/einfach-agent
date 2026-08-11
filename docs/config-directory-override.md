# 多实例配置目录

桌面版可以通过 `WEB_AGENT_CONFIG_DIR` 为每个运行实例选择独立的配置目录。它只决定 `config.json` 的位置，不提供或读取模型 API Key。

## 路径规则

- 未设置 `WEB_AGENT_CONFIG_DIR` 时，使用默认位置 `~/.webAgent/config.json`。
- 设置后，值必须是非空的绝对目录；应用使用 `${WEB_AGENT_CONFIG_DIR}/config.json`。
- 空值或相对路径会使配置操作受控失败，不会静默回退到默认目录。
- 覆盖值必须是 Web Agent 专用配置目录。首次使用时请指定尚不存在的目录，让应用创建它；在 Unix 上，已存在的目录必须是私有的 `0700`，不合格会受控失败且不会回退。

默认路径首次使用时，如果 `~/.webAgent/config.json` 不存在，应用才会安全复制旧
`~/.web-agent/config.json`。新文件存在时始终优先使用它，旧文件不会被删除或改写；设置
`WEB_AGENT_CONFIG_DIR` 的覆盖目录时不会执行迁移。

每个目录都有自己的 `config.json`，因此模型凭据彼此隔离。本次目录迁移只决定 `config.json` 的位置，不迁移既有浏览器 `localStorage`。项目工作区中的 `.webAgent/skills` 是项目 Skills 目录，不是用户配置目录。

## 同时启动两套实例

在 macOS 或 Linux 的 zsh/bash 中，可以分别指定两个绝对目录启动：

```sh
WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-work" pnpm tauri dev
WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-personal" pnpm tauri dev
```

也可以先在当前终端选择一套配置，再启动应用：

```sh
export WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-work"
pnpm tauri dev
```

切换实例时，请在启动命令中指定另一目录；不要把 `config.json` 文件路径本身赋给该变量。若要显式使用默认目录，可设为 `WEB_AGENT_CONFIG_DIR="$HOME/.webAgent"`。

## 密钥边界

模型 API Key 不能从任何环境变量读取。仍须在桌面应用的模型凭据输入界面中填写；应用会把凭据保存到当前所选目录的 `config.json`。
