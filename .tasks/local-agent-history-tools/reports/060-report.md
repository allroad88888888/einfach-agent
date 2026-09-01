# 060 执行报告

## 实现

- 新增 Node history provider、四条 host command、严格 command envelope/target 收窄、service cursor、稳定 merge 与只读 recovery reader。
- 默认 Node host 的 history provider 与 rollout routes 共用同一 persistence executor 和 rollout driver；注入 `agentHistoryProvider` 时直接借用该 identity，不重复构造。
- 每个 public 方法先 reconcile；source warning 转为 `AGENT_HISTORY_SOURCE_CORRUPT`，projection warning 保留为 `PROJECTION_LAG`。
- canonical target 的 items/read 优先；仅 canonical target 不存在时读取 legacy，legacy warning 不丢失。
- recovery reader 只 SELECT，复用 `validateRecoverySnapshot` 并保持现有 SQLite driver 的 fail-loud row/JSON/session/generation 语义。

## 验证

- 定向 Vitest：7 files / 24 tests PASS。
- `pnpm exec tsc -b --pretty false`：PASS。
- 先 build core 后 `pnpm --filter @einfach-agent/host-node build`：PASS（host 单独 build 会读取未刷新 core dist，因此按工作树依赖顺序构建）。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：PASS。
- owner 普通文件全部 `<=300`；最大为 `commandArgs.ts` 290 行、`createNodeHostInvoke.ts` 211 行。

## 尚未关闭

- 全局 list/search 的 canonical 与 legacy 跨来源分页仍不是完整的统一 snapshot/keyset：当前 canonical continuation 与 legacy continuation 分源，不能证明任意交错 updatedAt/rank 下多页无遗漏重复。
- legacy list-items 尚未提供 service cursor，四方法最终 envelope 也尚未全部实施严格 100,000 字符裁剪。
- 因此本轮没有把任务标记 done；需要继续补统一 source cursor、逐来源消费 watermark、全局预算器及对应多页/预算测试。

## Simplified R2（scope cut）

- 删除 R1 的跨来源 global merge 设计；global list 只透传 canonical repository，global search 只透传 FTS，均不读取 recovery 或 child archive。
- targeted 四方法先执行无过滤 canonical catalog presence；存在时只走 canonical，即使 status/query 无命中也不 fallback；不存在时只读取指定 legacy target。
- legacy items/search 使用严格 versioned base64url offset cursor，绑定 kind、target、规范化 roles、query 与 includeDeleted；两页可续且换 filter 拒绝。legacy list 只有单 target summary，不做 filesystem scan。
- 新增最终 envelope budget helper；legacy items/search按完整结果裁剪并生成 continuation，首项不可容纳时抛 `RangeError`；read/list与追加 warning 后的 canonical结果也执行最终 100k assert。
- reconcile reject 与 source warning均在查询 I/O 前转换为 `AGENT_HISTORY_SOURCE_CORRUPT`；projection warning保持 `PROJECTION_LAG`。
- host query按 trim 后 Unicode code points校验1..1000；offset/query各读取一次；恢复46命令全量编译穷举，history参数通过独立 module augmentation 提供。
- 默认 host仅创建一个 executor facade，同时交给 rollout driver、recovery reader和history provider；borrowed provider保持原identity。
- public legacy items/read/search剥离adapter内部 `modelItem`，仅read内部用它生成文本。

### R2 验证

- 定向 Vitest：7 files / 33 tests PASS。
- `pnpm exec tsc -b --pretty false`：PASS。
- `pnpm --filter @einfach-agent/host-node build`：PASS。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：PASS。
- 19个060 owner普通文件均`<=300`；最大为`commandArgs.ts` 290行，history service 117行。

## Simplified R3

- 新增独立 capability runtime input normalizer；四方法均在 reconcile 之后、catalog presence和任何查询/legacy I/O之前校验。覆盖list/items 1..100、read safe offset与1..20000、search trim后1..1000 Unicode code points与1..50，以及严格statuses/roles/includeDeleted/target/cursor。
- 新增 canonical service-warning budget：追加`PROJECTION_LAG`导致最终页超限时，以更小的同源limit重查，让030/050生成精确source cursor；返回`PROJECTION_LAG`、`OUTPUT_TRUNCATED`且最终envelope不超过100k，不引入跨source状态。
- 修正46命令测试注释：无Rust对应物为16条，包含四条history查询。
- direct provider测试覆盖list/items/read/search非法输入与非法filters，并断言query/recovery I/O均未发生；真实canonical list测试覆盖projection warning触发重预算及第二页无重复遗漏，generic items/search预算测试覆盖source cursor保留。

### R3 验证

- focused Vitest：9 files / 55 tests PASS。
- `pnpm exec tsc -b --pretty false`：PASS。
- `pnpm --filter @einfach-agent/host-node build`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：PASS。
- R3后23个owner文件全部`<=300`；最大`commandArgs.ts` 290行，service 139行。
