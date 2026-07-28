# run_verification_command

在本机 shell 中执行核验所需的验证命令，为结论取得真实执行证据。

## 参数
- `command`（必填）：非空 shell 命令，可直接运行项目脚本，例如 `bash scripts/verify.sh`。

## 使用准则
- 只用它核验结论，例如运行项目自带的 test / lint / typecheck 命令和验证脚本。
- 命令在会话 workspace 根目录下执行，超时 600000ms，输出上限 100000 字符。
- 退出码非 0 是有效证据，不是工具故障：结果的 `details` 里带 `exitCode`、`stdout`、`stderr`，
  请依据它们下判断，不要凭推测断言通过或失败。
- 结果显示 shell 不可用（例如非桌面运行环境）时，说明这一条本轮拿不到执行证据；
  应如实说明缺少证据，不要把"没跑成"当作"没通过"。
