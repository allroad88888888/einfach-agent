# 420 接入现有用户提问工具（2026-09-21，完成）

## 实现

- 用户确认直接依赖现有工具包，复用 ask_user_question，无源码复制。
- `browser-agent/agent/package.json` 增加 `@einfach-agent/tools-interaction` workspace 依赖，锁文件同步。
- `browser-agent/agent/src/client.ts` 导入并注册 `askUserQuestionTool`。
- 仅注册提问工具；没有调用整包 registerInteractionTools，也没有注册 browser_action/save_file。
- 提问 payload、waiting_user、答案回填、恢复持久化继续使用现有 core；展示使用现有 DecisionCards。
- 新增 `browser-agent/ui/src/chat/askUserQuestion.integration.test.tsx`；更新工具清单断言与运行包 README。

## 验证

- 新集成测试通过真实 client/core/registry、现有配置 UI、DecisionCards、IndexedDB 完成：配置启用 → 新会话 → 模型请求工具 schema → 调用 ask_user_question → 暂停 → 关闭并重新创建 client → 恢复问题 → 四种答案提交 → 模型收到准确 answers → done。
- 文本、单选、多选、确认 false 均覆盖；验证其他会话保持空白、未注册额外 interaction 工具。
- 模型传输在测试中使用确定性模拟，实际运行状态、工具调用和持久化没有手工伪造。
- `pnpm exec vitest run browser-agent tools/interaction scripts/check-boundaries.test.js`：77 文件 / 282 测试通过。
- TypeScript 项目检查通过；tools-interaction、browser-agent、UI、extension、embedded example 构建通过。
- 边界、文档与 git diff --check 通过。

## 实际 Chrome

- 重新加载已安装扩展，实际配置目录出现 ask_user_question。
- 在 ai录数 r2 的 25 项工具基础上勾选该工具，显示 26 项已选；保存后为 ai录数 r3。
- 选择 r3，在当前业务页面新建并绑定会话，界面显示“项目问题详情 / ai录数 r3 / 准备好了”。
- 原有 r2 会话保留其原始工具快照；没有删除用户本轮新产生的历史。
- 未修改业务表单、选择任何业务候选、提交工单或读取 API Key。
- 未发送真实模型验证消息；当前新会话为空，直接可供用户使用。

未创建远程 issue，未提交或推送代码。
