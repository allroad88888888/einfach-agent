# 多实例配置目录

读写 `config.json` 的是**本机 Node 后端**（`pnpm serve` 起的服务，以及 CLI）。它们可以通过 `WEB_AGENT_CONFIG_DIR` 为每个运行实例选择独立的配置目录。该变量只决定 `config.json` 的位置，不提供也不读取模型 API Key。

注意 SQLite 库文件**不跟随**这个变量（理由见 `packages/host-node/src/sqlite/databasePath.ts` 的文件头）——它隔离的是配置，不是会话数据。

## 路径规则

- 未设置 `WEB_AGENT_CONFIG_DIR` 时，使用默认位置 `~/.webAgent/config.json`。
- 设置后，值必须是非空的绝对目录；应用使用 `${WEB_AGENT_CONFIG_DIR}/config.json`。
- 空值或相对路径会使配置操作受控失败，不会静默回退到默认目录。
- 覆盖值必须是 Einfach Agent 专用配置目录。首次使用时请指定尚不存在的目录，让应用创建它；在 Unix 上，已存在的目录必须是私有的 `0700`，不合格会受控失败且不会回退。

默认路径首次使用时，如果 `~/.webAgent/config.json` 不存在，应用才会安全复制旧
`~/.web-agent/config.json`。新文件存在时始终优先使用它，旧文件不会被删除或改写；设置
`WEB_AGENT_CONFIG_DIR` 的覆盖目录时不会执行迁移。

每个目录都有自己的 `config.json`，因此模型凭据彼此隔离。本次目录迁移只决定 `config.json` 的位置，不迁移既有浏览器 `localStorage`。项目工作区中的 `.webAgent/skills` 是项目 Skills 目录，不是用户配置目录。

## 同时启动两套实例

在 macOS 或 Linux 的 zsh/bash 中，可以分别指定两个绝对目录启动：

```sh
WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-work" pnpm serve
WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-personal" pnpm serve
```

（CLI 同理：`WEB_AGENT_CONFIG_DIR=… pnpm cli -p "…"`。）

也可以先在当前终端选择一套配置，再启动应用：

```sh
export WEB_AGENT_CONFIG_DIR="$HOME/.webAgent-work"
pnpm serve
```

切换实例时，请在启动命令中指定另一目录；不要把 `config.json` 文件路径本身赋给该变量。若要显式使用默认目录，可设为 `WEB_AGENT_CONFIG_DIR="$HOME/.webAgent"`。

## 密钥边界

浏览器一侧，模型 API Key 不能从任何环境变量读取，仍须在模型凭据输入界面中填写，由本机后端保存到当前所选目录的 `config.json`；前端任何路径都读不回明文 Key。CLI 是个例外，它**可以**从环境变量取 Key（`DEEPSEEK_API_KEY` 等，见 `apps/cli/src/credentials.ts`）——那是一个本机进程直接持有凭据，与浏览器那条受限通路的威胁模型不同。
