# 020 模型回归夹具报告

状态：DONE

## 已完成

- GLM Turbo 的低价抽取回归夹具现在断言请求不携带 `reasoning_effort`，同时保留 GLM 模型与低价路由覆盖。
- DeepSeek Thinking 投影夹具改用公共 `DEFAULT_DEEPSEEK_MODEL`，继续验证 temperature 不上行、thinking 与 high effort 上行，且会话 temperature 保持不变。
- 取消命令路由清单补入现有的 `model_connection_profile_probe`，仍断言流式请求转发不在 invoke 表中。

## 验证

- `pnpm exec vitest run packages/subagents/src/defaultTierRouting.test.ts packages/agent-core/src/runtime/modelRun.requestProjection.test.ts packages/host-node/src/model/cancelCommands.test.ts`：21 passed
- `pnpm exec tsc -b --pretty false`：通过
- `git diff --check -- <任务三文件>`：通过
- `wc -l`：152、266、116；均未超过 300 行

生产行为与任务规定的三项精确能力契约一致，未修改生产代码。
