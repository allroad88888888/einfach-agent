# 040 独立审查：仅支持 Kimi K3

结论：**APPROVED**。

## 审查范围

- 已完整阅读 `040-kimi-k3-protocol.md`、`reports/040-report.md` 与 `index.md`。
- 以 `98816b041b42d55ee3308a909af8e8cf7f646f36` 为 base；当前 `HEAD` 与该 base 相同，审查
  任务卡列出的范围文件工作树 diff，并单独纳入未跟踪
  `packages/agent-ai/src/kimiK3Protocol.test.ts`。
- `builtinProviders.test.ts` 及 `.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、CSS、
  `apps/desktop/gen/` 等既有脏改动不属于 040 范围，未审查、未修改。
- 按 `one-file-one-thing` 检查物理行数与职责；本审查只新增本报告，没有修改产品实现或测试。

## 按严重性 findings

### Critical

无。

### Important

无。

### Minor

无阻断性代码或测试发现。

### Informational

1. 当前宽回归实测为 36 files 中 28 passed / 8 failed、270 tests 中 254 passed / 16 failed；
   `040-report.md` 记录的是 269 tests 中 253 passed / 16 failed。失败文件与失败数没有新增，差异只
   是当前工作树多计入一项通过测试，不影响结论。
2. 永久测试以 direct `callKimi` 覆盖底层非流式边界，以 `streamModel` 覆盖流式完整链路；
   `streamKimi` 自身没有单独的脏 effort 测试。不过 call/stream 都调用同一个
   `prepareKimiRequest()`，审查时另以注入 fetch 的 direct `streamKimi` 探针验证了该边界，未发现
   行为缺口。

## 验收标准逐条判定

1. ✅ **Kimi 目录只剩 `kimi-k3`，vendor fallback 与 exact model context 均为 1M。**
   - `kimiRegion.ts:3-4` 导出 `KIMI_K3_MODEL = 'kimi-k3'`，且
     `DEFAULT_KIMI_MODEL` 指向它；`index.ts` 继续导出 `kimiRegion` 公共面。
   - `builtinModelDescriptors.ts:111-118` 的 Kimi descriptor 只有 `kimi-k3`，vendor 与模型
     context 均为 `1_000_000`。
   - `builtinThinkingCapabilities.test.ts` 用完整六模型固定数组钉住 registry，并分别断言 Kimi
     vendor fallback 与 exact model 的 1M。

2. ✅ **Thinking capability 为 required + low/high/max + default max。**
   - `builtinModelDescriptors.ts:68-74` 的 `KIMI_K3_THINKING` 精确声明 `required: true`、
     `efforts: ['low', 'high', 'max']`、`defaultEffort: 'max'`。
   - 能力测试同时验证 `modelRequiresThinking()` 为 true、efforts 冻结且 default enabled。

3. ✅ **K3 最终 wire 不发送 `thinking`，只投影合法 `reasoning_effort`；Auto 与脏值 fail closed。**
   - `builtinProviders.ts:171-191` 先按 Kimi/K3 exact capability 判断，再无条件丢弃通用投影中的
     `thinking`，仅从 settings 白名单恢复 low/high/max。
   - `kimi.ts:30-50` 在最终 fetch 边界再次剥离 `thinking`、四个不支持的采样字段与任意非法
     effort，只保留 low/high/max；`callKimi` 与 `streamKimi` 共用该函数。
   - `kimiK3Protocol.test.ts` 覆盖三种合法 effort、Auto、medium/xhigh/minimal/none/dirty、direct
     call、CN 默认端点、global stream、`include_usage` 与 `thinking` 删除。
   - 额外 direct `streamKimi` 探针输入 `thinking:disabled + reasoning_effort:medium`，捕获的 global
     fetch body 只有 K3 model/messages/stream fields，无 `thinking` 或 `reasoning_effort`。

4. ✅ **region、credential 与 Pro/Flash routing 正确。**
   - `kimiRegion.ts:1-13` 保留 CN/global URL，缺省 region 为 CN；协议测试覆盖非流式 CN 与流式
     global 的实际 URL。
   - `ModelCredentialPanel.tsx:21-29,75-80` 通过 `DEFAULT_KIMI_MODEL` 展示并创建 CN K3 会话；
     `startupCredentialTarget.test.ts:10-25` 验证 K3 缺省/CN 取 `kimi-cn`，global 仍受控拒绝，符合
     当前 credential surface。
   - `defaultTierRoutingTable.ts:46-55` 的 Kimi Pro/Flash 均使用 `DEFAULT_KIMI_MODEL`；routing 测试
     验证两档映射、Kimi 会话覆盖与实际低价抽取 body 为 `kimi-k3`、保留合法 high、无
     `thinking`。

5. ✅ **测试、类型、边界与文件规则符合任务卡。**
   - 五个专项文件复跑 60/60；subagents 包复跑 75/75；`tsc -b`、`check:state`、
     `check:boundaries` 均通过。
   - 范围 tracked diff `git diff --check` 无输出；新测试尾随空白扫描无命中；范围文件旧
     `kimi-k2.6`/`Kimi K2.6` 扫描无命中。
   - 任务卡 11 个文件物理行数依次为 82、18、126、290、107、158、153、74、192、146、36，
     全部低于普通文件 300 行硬上限。新增 `kimiK3Protocol.test.ts` 153 行，只负责 K3 请求协议；
     其余文件仍能以单一业务点或抽象说明职责。

## 命令证据

```sh
git rev-parse HEAD
# 98816b041b42d55ee3308a909af8e8cf7f646f36

pnpm exec vitest run \
  packages/agent-ai/src/builtinThinkingCapabilities.test.ts \
  packages/agent-ai/src/thinkingRequestProjection.test.ts \
  packages/agent-ai/src/kimiK3Protocol.test.ts \
  packages/subagents/src/defaultTierRouting.test.ts \
  apps/web/src/settings/startupCredentialTarget.test.ts
# 5 files passed; 60 tests passed

pnpm exec vitest run packages/subagents/src
# 14 files passed; 75 tests passed

pnpm exec tsc -b --pretty false
# exit 0

pnpm check:state
# 5 rules passed; scanned 22 workspaces / 902 non-test TS/TSX files

pnpm check:boundaries
# 7 rules passed; scanned 918 non-test TS/TSX files; only existing exemptions reported

pnpm exec vitest run packages/agent-ai/src
# 28 passed / 8 failed files; 254 passed / 16 failed tests

git diff --check 98816b041b42d55ee3308a909af8e8cf7f646f36 -- <040 tracked files>
# no output

wc -l <040 files including packages/agent-ai/src/kimiK3Protocol.test.ts>
# max 290; new protocol test 153
```

另外执行了 direct `streamKimi` 注入-fetch 探针；结果为 global URL
`https://api.moonshot.ai/v1/chat/completions`，捕获 body 不含 `thinking` 与非法
`reasoning_effort`，并保留 `stream:true` 和 `stream_options.include_usage:true`。

## Coverage 结论

- **C-01：满足。** 六模型 registry 的 Kimi 切片精确为 K3，双层 1M context 有固定断言。
- **C-06：满足。** K3 required、不可关闭、三档与默认 max 均有 capability 断言。
- **C-07：满足。** adapter 与最终 call/stream 边界双层过滤；合法三档、Auto、脏值、CN/global、
  非流式/流式均有测试或独立探针证据。
- **C-10：满足。** Kimi Pro/Flash 只产出 K3，且真实抽取 wire 无退役 `thinking` 字段。
- **Credential surface：满足。** CN K3 使用 `kimi-cn`，global 保持既有受控失败，没有引入未经
  支持的凭据作用域。
- 宽回归的 16 项失败全部仍落在已报告的旧 GLM/Kimi 夹具集合：Kimi 图片链路归 045，退役目录/
  协议夹具归 055；其中既有脏 `builtinProviders.test.ts` 不在本审查范围。它们不揭示 040 的 K3
  文本协议、目录、credential 或 routing 缺陷，故不阻断本叶批准。

## 最终判断

040 的目录、1M context、required Thinking、K3 wire、direct call/stream 防泄漏、region、credential
与 tier routing 均满足任务卡；专项门与文件硬规则通过。没有 Critical 或 Important findings，批准。
