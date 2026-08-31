# 020 独立审查：探测兼容端点模型

## 结论

**APPROVED**。指定范围内实现满足本叶验收标准；未发现 Critical 或 Important 问题。报告声明的聚焦测试、host-node build 与 `git diff --check` 已通过；按任务文件的 index 裁决，全仓 `tsc -b` 留给 060/070，不构成本轮失败。

## 审查依据与范围

- 任务文件：`.tasks/model-connection-center/020-connection-model-probe.md`
- 执行报告：`.tasks/model-connection-center/reports/020-report.md`
- tracked 文件相对基线 `c7befb48ea8c38a91d10c58097cb1206fbef8cc1` 的指定范围 diff
- 指定新增文件以及 git 视为未跟踪的本任务 host/web 文件的 `--no-index` diff
- 未重跑执行报告已经声明的命令。

## 验收标准逐条判定

### 1. host-node probe 与命令边界：✅

- URL 验证：`probeConnectionProfileModels` 在创建请求前先调用既有 `requireOpenAiCompatBaseUrl(input.baseUrl)`；测试覆盖非 HTTPS 公网地址、userinfo 和 query，均在 fetch 前以 `target-not-allowed` 拒绝，同时保留既有校验规则而未复制实现。
- 精确路径：请求 URL 仅由 `` `${baseUrl}/models` `` 构成；测试把带空白、尾斜杠的 `/v1/` 输入钉死为 `https://gateway.example.com/v1/models`，method 钉死为 `GET`。
- 跳转：fetch 明确设置 `redirect: 'manual'`；3xx 的 `Response.ok` 为 false，随后走固定 `upstreamFailed`，因此不会自动跟随到另一 origin。
- Key 边界：可选 Key 先经既有 `normalizeApiKey`；合法值仅进入本次请求的 Bearer header。无 Key 分支明确不设置 Authorization，probe 的依赖和实现中也没有配置/credential 读取入口。
- 超时：默认 10 秒 AbortController 定时器，signal 传入 fetch，并在 finally 清理 timer；网络与 abort 异常统一净化。
- 响应限制：先拒绝超过 256 KiB 的声明长度，再通过 `ReadableStream` 分块累计实际字节并在越界时拒绝；另有 1,000 条模型和单 ID 200 UTF-8 bytes 上限。
- 响应形状：要求对象的 `data` 为数组，每项为对象且 `id` 为字符串；ID trim 后拒绝空值、控制字符和超长值，随后去重、排序并映射为 `{ id, label: id, source: 'discovered' }`。畸形及声明/实际超大 body 均有聚焦测试。
- 错误秘密回显：非 2xx 不读取或拼接上游 body；流读取、JSON、形状、网络和超时错误均转换为固定域错误。测试以已知秘密覆盖上游 body、Key 与底层网络/abort 异常，断言错误字符串不含秘密。
- 严格 command 窄化：handler 要求顶层精确只有 `input`；input 的已定义 key 精确限定为 `baseUrl` 及可选 `apiKey`，并检查两者类型。测试覆盖缺失 input、缺失 baseUrl、额外字段和错误类型，且确保拒绝发生在 fetch 前。
- 无配置写入：probe handler 仅调用纯 probe 函数，未接收 `NodeHostInvokeOptions`，因此没有配置写入口；命令测试还比较调用前后配置文件内容完全一致。
- 命令登记与分发：新命令加入命令全集、参数契约和 model routes；命令全集/分发测试同步更新。执行报告记录聚焦 4 文件共 33 项测试通过。

### 2. web server/static adapter：✅

- `ModelConnectionProfileHost` 增加了题定的 `probe({ baseUrl, apiKey? })` 返回契约。
- server adapter 的 probe 唯一调用 `model_connection_profile_probe`，payload 精确为 `{ input }`；测试同时钉住 command、request 与 response。
- static host 的 probe 复用 unavailable 拒绝函数并始终 reject；测试验证未连接本机后端时不可探测。
- 执行报告记录该测试文件 2 项全部通过。

### 3. 构建与 diff 门：✅

- 执行报告记录 `pnpm --filter @einfach-agent/host-node build` 通过。
- 执行报告记录 `git diff --check` 通过。
- 全仓 `tsc -b` 的剩余错误位于旧单模型消费方；任务文件明确将该总门裁决到 060/070，因此不以当前跨叶中间态判本轮失败。
- 行数与单一职责符合全局硬规则：本任务文件均不超过 300 行；probe 实现（122 行）与其测试（105 行）职责集中，没有机械拆分或大杂烩命名。

## 质量发现

### Critical

- 无。

### Important

- 无。

### Minor

- 测试通过 `redirect: 'manual'` 参数断言间接覆盖跳转策略，但没有单独构造 3xx 响应并断言受控错误。实现逻辑已由 `!response.ok` 明确拒绝 3xx，故这是测试表达完整度建议，不影响验收。
- 1,000 模型数和 200-byte ID 上限在实现中清晰存在，但指定 probe 测试未分别钉住边界值；当前已有畸形与 body 双重限额测试，故不影响本轮结论。
