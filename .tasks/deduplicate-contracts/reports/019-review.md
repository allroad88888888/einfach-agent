# 019 独立审查

结论：**APPROVED**。任务卡四项验收标准均满足；未发现阻断合入的实现、测试质量、文件职责或提交隔离问题。

## 质量发现

### Critical

- 无。

### Important

- 无。

### Minor

- 无。

## 逐条验收

### 1. 独立 owner、body 模块职责与无跨业务 re-export

通过。

- `apps/server/src/jsonContentType.ts:10-14` 是 `hasJsonContentType` 的实现位置，文件只负责判断请求是否声明允许的 JSON media type。
- `apps/server/src/invokeRouteBody.ts:31-43` 仅导出并实现 invoke body 的读取与对象投影；与基线的范围内 diff 对比，唯一业务逻辑变化是移除 Content-Type 判据，其余 body 投影逻辑保持原样。
- `apps/server/src/modelRouteBody.ts:55-63` 只保留 model body 读取与空 body 映射；基线中的 `export { hasJsonContentType } from './invokeRouteBody'` 已删除。
- 对任务卡七个文件做符号检索，`hasJsonContentType` 仅出现在独立实现、独立测试及两个直接消费者中；两个 body 文件均无该符号，也无跨业务转发。

### 2. Content-Type 安全语义、测试迁移与两路由直接接线

通过。

- `apps/server/src/jsonContentType.ts:11-14` 对缺失或非字符串头 fail closed；media type 在去参数、去首尾空白并转小写后，严格等于 `application/json` 才放行。因此不会把 `text/plain`、表单编码或 multipart 当作 JSON，同时保留大小写不敏感和允许参数的既有契约。
- `apps/server/src/jsonContentType.test.ts:11-15` 覆盖裸 `application/json`、大小写变体及 charset 参数；`:17-22` 覆盖缺失头和浏览器表单可提交的三种媒体类型。与 `git diff c804cd4 --` 中删除的旧用例逐项对照，正反例完整迁移，没有丢失契约案例。
- `apps/server/src/invokeRoute.ts:28` 与 `apps/server/src/modelRoute.ts:52` 均直接从 `./jsonContentType` 导入；实际调用分别在 `invokeRoute.ts:70` 与 `modelRoute.ts:100`。
- 两个路由的 415 分支仍分别位于 `invokeRoute.ts:70-78`、`modelRoute.ts:100-108`，状态码 `415`、错误码 `unsupported_media_type` 和错误消息均未变化。范围内 diff 显示路由只改了 import 来源，body 读取和其余 HTTP 控制流没有改变。
- `apps/server/src/invokeRouteBody.test.ts` 的 diff 只移走 Content-Type 用例与对应 import，原 body reader 测试未被改写。

### 3. 报告所列验证

通过（按 reviewer 指令不重跑报告声称已运行的测试）。

- 实现报告 `019-report.md:16` 记录指定 Vitest 命令通过：4 个测试文件、43 个测试。
- 实现报告 `019-report.md:17` 记录 `pnpm exec tsc -p apps/server/tsconfig.json --noEmit` 通过。
- 本次仅对任务卡文件执行的 `git diff --check c804cd4 -- ...` 无输出，未见空白错误；这不是对上述测试或类型检查的复跑。

### 4. 单一职责与物理行数

通过。按 `wc -l` 口径：

| 文件 | 行数 | 单一职责判断 |
| --- | ---: | --- |
| `jsonContentType.ts` | 15 | 判断请求是否声明 JSON media type |
| `jsonContentType.test.ts` | 23 | 验证 JSON Content-Type 判据 |
| `invokeRouteBody.ts` | 43 | 将 invoke 请求体投影为命令参数对象 |
| `invokeRouteBody.test.ts` | 86 | 验证 invoke body 投影 |
| `invokeRoute.ts` | 119 | 处理 invoke HTTP 路由 |
| `modelRouteBody.ts` | 63 | 读取 model 路由 JSON 请求体 |
| `modelRoute.ts` | 150 | 处理 model 代理 HTTP 路由 |

七个文件均低于普通文件 300 行硬上限；职责可各用一句不含“和/以及”的话说明，未见假拆分或测试杂糅。

## 范围与提交隔离

- 以基线 `c804cd4` 限定任务卡七个文件审查：5 个已跟踪文件为修改状态，2 个新增 owner/测试文件为未跟踪状态；全部都在任务卡 `files` 列表内。
- 已跟踪 diff 仅包含 Content-Type 所有权迁移、直接 import 接线、旧测试移除及相关职责注释收敛；两个新增文件分别承载实现和测试，未夹带另一业务改动。
- 按任务要求未检查、评价或依赖并行 017/018/020 的改动，也未修改产品代码、任务文档或创建提交。
