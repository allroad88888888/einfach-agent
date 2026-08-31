# 050 独立审查：解析非秘密连接清单

## 结论

APPROVED。两条验收标准均满足；范围内实现符合任务规定的安全解析契约。发现 1 项 Minor 测试覆盖改进点，无阻断问题。

## 审查范围

本审查只基于：

- `.tasks/model-connection-center/050-profile-manifest-import.md`
- `.tasks/model-connection-center/reports/050-report.md`
- `modelConnectionProfileManifest.ts` 的未跟踪新增文件等价范围 diff
- `modelConnectionProfileManifest.test.ts` 的未跟踪新增文件等价范围 diff

按任务裁决，未将全 app TypeScript 总门作为本轮失败条件，也未重跑执行报告已声明的命令。

## 验收标准逐条判定

### 1. 专属 Vitest 覆盖并通过

✅ 通过。

证据：

- 执行报告记录命令 `pnpm exec vitest run apps/web/src/settings/modelConnectionProfileManifest.test.ts` 通过，结果为 1 个文件、16 个测试全部通过。
- 合法最小清单：测试 `parses the minimum non-secret manifest into manual model drafts` 验证尾斜杠规范化、默认 model label 及 `source: 'manual'`。
- 模型 label：测试 `keeps an optional model label` 验证显式 label 保留。
- 重复 ID：测试 `rejects duplicate model IDs` 验证固定错误文案。
- 未知字段及 Key/headers：参数化测试覆盖 connection 上的 `apiKey`、`token`、`headers`、`apiPath`、`adapter`，以及 model 上的未知 `apiKey`；实现还分别对白名单根、connection、model 调用 `requireExactFields`。
- 坏 URL：参数化测试覆盖公网 HTTP、用户名密码、query、fragment；回环 HTTP 正向测试验证与 host 规则一致的规范化结果。
- 超限文本：测试使用 `64 * 1024 + 1` 字符并验证固定错误。
- 无秘密输出：测试序列化返回结果后确认不含 `apiKey`、`token`、`headers`；接口本身只导出 `label`、`baseUrl`、`models`，不含 connection ID。
- 实现错误均为固定中文文案，不拼接输入；文本、模型数、label、model ID、base URL 均有显式上限。
- 实现是同步纯函数，仅做 `JSON.parse`、校验与转换，范围 diff 中无网络、store、atom 或持久化调用。

### 2. `git diff --check`

✅ 通过。

证据：执行报告明确记录 `git diff --check` 通过、无空白错误；审查到的两份新增文件 diff 也未见尾随空白或冲突标记。

## 质量发现

### Critical

无。

### Important

无。

### Minor

1. 严格白名单的回归测试没有显式覆盖根级未知字段和任务特别点名的 `connection.id`。当前实现确实会通过根/connection 的 `requireExactFields` 拒绝它们，因此不是功能缺陷；但补充这两个用例能更直接锁定“根未知字段一律拒绝”和“导入不得指定 connection ID”这两项安全契约。

## 文件职责与行数

✅ 符合硬规则。实现文件 107 行，只负责安全解析 manifest；测试文件 87 行，只负责该解析器契约测试。两者均低于普通文件 300 行上限，命名明确，未出现机械拆分或多职责混杂。
