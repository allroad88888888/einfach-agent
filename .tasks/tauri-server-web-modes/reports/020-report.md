# 020 执行报告

## 改动摘要

- 为 server CLI 新增 `--ready-json`，解析结果以 `readyJson` 表示，并隐含 `open: false`；帮助文本同步说明该选项。
- 新增 `mainReadyFrame.ts`，导出固定的 kind、version、`ServerReadyFrame` 接口以及单行 JSON 序列化函数。
- `runServerCli()` 在 ready-json 模式监听成功后仅向 stdout 写一帧 JSON，不启动浏览器；关停诊断改写 stderr。未传该选项时仍走既有中文启动文案与浏览器行为。
- 补充 CLI flag、ready-frame 格式、单行 stdout、浏览器禁用、stderr 诊断及旧模式行为测试。

## 逐条验收命令与结果

1. `pnpm exec vitest run apps/server/src/mainCliOptions.test.ts apps/server/src/mainReadyFrame.test.ts apps/server/src/mainRunServer.test.ts`
   - 通过：3 个测试文件、23 个测试全部通过。
2. `pnpm --filter @einfach-agent/server build`
   - 通过：tsup ESM 构建成功，`embed-web-dist` 成功复制既有 Web dist。
3. `wc -l apps/server/src/mainCliOptions.ts apps/server/src/mainCliOptions.test.ts apps/server/src/mainReadyFrame.ts apps/server/src/mainReadyFrame.test.ts apps/server/src/mainRunServer.ts apps/server/src/mainRunServer.test.ts`
   - 通过：依次为 86、77、13、25、100、190 行，均不超过 300 行。
4. `git diff --check -- apps/server/src/mainCliOptions.ts apps/server/src/mainCliOptions.test.ts apps/server/src/mainReadyFrame.ts apps/server/src/mainReadyFrame.test.ts apps/server/src/mainRunServer.ts apps/server/src/mainRunServer.test.ts`
   - 通过：无空白错误。

## 未验证项

- 未执行任务范围外的全仓 `pnpm test`、`pnpm build`、边界检查或状态检查；本叶仅执行任务列出的定向测试与 server build。
- 未以真实 Tauri child 启动 server；该集成属于后续 040/050 任务。

## 范围外发现

- 索引已记录：全量 `pnpm test` 受用户已删除的 `apps/web/src/agentNew/ui/UndoBar.tsx` 对应 invariant 测试阻塞。本任务未复跑、未修改该范围外问题。

## 疑虑

- 无。

## 建议后续动作

- 040 可直接以 `--ready-json --host 127.0.0.1 --port 0` 启动 Node child，并按 `SERVER_READY_KIND` / `SERVER_READY_VERSION` 校验首帧后读取唯一的 `url` 字段。
- 独立 reviewer 复核 stdout 单帧约束及 token 仅位于 ready frame 的 `url` 字段。
