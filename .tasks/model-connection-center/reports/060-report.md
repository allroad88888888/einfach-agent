# 060 执行报告

R1 验收重跑：2026-08-21。065 已迁移旧测试夹具，本轮未修改产品代码。

## 改动摘要

- 将第三方连接 UI 迁移为一条连接包含多个模型：保存卡片展示来源、协议、Key 配置状态及模型列表，每个模型分别提供新建对话和设为默认动作，不再把首个模型隐式视作默认。
- 新增来源选择器，按云端服务商、自部署、本地呈现 040 预设；预设只预填名称、Base URL、模型，不写入 Key。
- 新增模型选择器：探测结果仅展示，用户勾选后才进入草稿；支持手动添加和移除模型，并呈现探测错误。
- 编辑器仅负责连接字段、写入式 Key 和“测试并发现模型”；保存后 Key 不回显，连接卡不包含 Key 值。
- 绑定层接入 030 命令、040 预设、050 manifest 解析；JSON 使用本地 FileReader，成功仅预填非秘密草稿并清空 Key，失败留在编辑器显示通用错误。
- 新建会话只写 `{ vendor: 'openai-compat', model, vendorSettings: { connectionId } }`；默认保存为 `{ id, model }`。
- 补充来源、模型、多模型卡片、集成会话/默认、静态隐藏与官方/第三方文案测试及响应式样式。

## 逐条验收命令与结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/ModelConnectionProfileEditor.test.tsx apps/web/src/agentNew/ui/ModelConnectionProfilesPanel.test.tsx apps/web/src/agentNew/ui/ModelConnectionSourcePicker.test.tsx apps/web/src/agentNew/ui/ModelConnectionModelPicker.test.tsx apps/web/src/agentNew/ui/ModelCredentialPanel.connections.test.tsx`
   - 通过：5 个测试文件、15 项测试全部通过。
2. `pnpm check:state`
   - 通过：扫描 869 个非测试 TS/TSX 文件，5 条状态规则全部通过；未新增 React 产品状态。
3. `pnpm exec tsc -b --pretty false`
   - 通过：全仓类型检查退出码 0，无诊断输出。
4. `wc -l` 检查任务全部 11 个文件
   - 通过：最大文件为 `ModelCredentialPanel.connections.test.tsx` 231 行，其余 26–81 行，均不超过 300 行。
5. `git diff --check -- <任务 files>`，并对未跟踪文件逐个执行 `git diff --no-index --check /dev/null <file>` 后筛查空白错误
   - 通过：无 trailing whitespace、space-before-tab 或 EOF 空白错误。

## 未验证项

- 未做桌面/移动浏览器截图与 visual lint：当前没有可独立稳定注入本机 profile host 的浏览器验收入口；组件响应式规则与行为由 jsdom 测试覆盖，但渲染视觉仍建议在 070 的集成环境复核。

## 范围外发现

- 首轮报告中的 3 个旧契约测试夹具问题已由 065 在其授权范围内迁移；R1 全仓类型检查确认问题已消失。
- R1 未发现新的范围外问题。

## 疑虑

- manifest FileReader 的成功/失败行为已由纯解析器安全测试及来源选择器文件转交测试间接覆盖，但 060 尚无绑定层 FileReader 成功与拒绝秘密字段的直接集成断言。
- 删除当前默认模型后，本实现清除整项默认而非选择连接中的另一个模型，符合“不得暗中把第一个模型当默认”，但产品可在后续考虑增加显式替换提示。

## 建议后续动作

1. 在可注入 server profile host 的浏览器 harness 中补桌面/移动截图和 visual lint。
2. 终审增加绑定层 FileReader 集成用例：合法 manifest 预填且 Key 为空；含 `apiKey`/未知字段的 manifest 保持编辑器并显示通用错误。
