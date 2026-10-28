# 020 独立审查

结论：**REJECTED**

本次按 `020-page-tools.md`、全局约束、交付报告和 scope diff 做静态审查；依任务要求未重跑报告中已通过的测试，也未修改产品代码。

## Findings

### Important — DOM host 没有实现宿主级写入串行调度

- 位置：`browser-agent/tools/page/src/dom-host.ts:21-35`
- `fillFields` 每次调用都立即执行自己的循环，没有共享队列、mutex 或其他 host 级调度。`fill_fields` 的 `execution.mode: 'serial'`（`src/fill-fields/fill-fields.ts:6`）只声明 core 对一次执行图内调用的调度策略，不能保证直接使用 `PageToolsHost` 时、不同 core run 时或其他宿主调用者并发调用时串行。
- 可复现影响：同一个 host 上并发发起两个 `fillFields`，让第一个 controlled adapter 的 `write` 等待、第二个先完成，再释放第一个；最终值会被较早请求覆盖，执行顺序与调用顺序相反。现有测试只有单次批内顺序，没有覆盖并发的重复写入。
- 违反：行为要求 6“每次写入在宿主串行调度下可执行”，以及 C06 的“重复写入”覆盖要求。该缺口会由 050 直接消费，不能留给扩展桥隐式补偿。

### Important — controlled adapter 可以重新暴露明确禁止读取的 password/hidden 字段

- 位置：`browser-agent/tools/page/src/dom-fields.ts:34-39`
- 原生候选集会排除 `input[type=password]` 和 `input[type=hidden]`，但 adapter 候选集随后对 `querySelectorAll('*')` 无条件运行 `matches`。因此一个匹配这些元素的 adapter 会把它们重新加入，并由 `readResolved` 在 `src/dom-fields.ts:41-42` 返回 adapter 的值。
- 可复现影响：注册 `matches: element => element instanceof HTMLInputElement` 的 adapter，页面含 `<input type="password" value="secret">` 或 `<input type="hidden" value="token">`；`readForm` 将输出 adapter 提供的敏感值。安全边界不应依赖每个客户 adapter 自行记得排除敏感控件。
- 违反：行为要求 1“不读取密码或隐藏 token 字段”和 C05 的安全读取边界。现有测试仅验证没有 adapter 时会排除这些字段，未覆盖 adapter 路径。

### Important — 写后回读不比较请求值，字段拒绝或规范化输入时仍报告成功

- 位置：`browser-agent/tools/page/src/dom-host.ts:29-32`、`browser-agent/tools/page/src/dom-write.ts:26-28`
- 写入后确实调用 `actualValue`，但该值未经任何比较就直接形成 `{ ok: true, value: actualValue(field) }`。例如 `input[type=number]` 请求写入字符串 `"abc"` 时，浏览器会把实际值清洗为 `""`；实现仍返回 `ok:true, value:""`。同步 `input`/`change` handler 将值回退，或 controlled adapter 没有接受请求值，也同样被宣称成功。
- 可复现影响：模型收到成功状态后会认为目标值已经可靠写入，后续校验或业务步骤基于错误状态继续。虽然返回值字段暴露了差异，但 `FieldOutcome.ok` 与“逐字段报告实际结果、不因失败宣称成功”的合同冲突。
- 违反：行为要求 3 的写后回读和真实逐字段结果，以及 C05/C06 的可靠填充、回读结果要求。现有测试只断言能够原样接受的值。

### Important — 显式 adapter 无法接管原生元素

- 位置：`browser-agent/tools/page/src/dom-fields.ts:34-39`
- 候选顺序固定为 `native`、`controlled`、`complex`，再按元素去重；因此只要元素是受支持或不支持的 `input`/`textarea`/`select`，原生候选总会先占位，后续匹配它的 adapter 被丢弃。公开的 `ControlledFieldAdapter.matches(element: Element)` 合同和 README 没有限制 adapter 只能匹配非原生标签。
- 可复现影响：客户为 React 等受控 `<input>` 注册显式 adapter 时，snapshot 仍按原生字段返回，写入也绕过 adapter；需要框架 setter 或专门校验的组件会静默走错路径。对 `input[type=file]` 等原生不支持字段注册 adapter 也不会生效。
- 违反：行为要求 2 的显式受控组件 adapter 支持及报告公开合同。现有 fixture 仅用 `div`，没有覆盖受控原生表单元素。

## 验收逐条判断

1. **部分通过**：报告记录 `pnpm exec vitest run browser-agent/tools/page` 为 6 文件、15 测试通过；测试覆盖原生读/填/校验、`div` 受控 fixture、部分失败、缺失 ID、非法类型。但缺少 adapter 敏感字段绕过、原生受控元素、回读值偏离请求值和宿主并发重复写入负例。
2. **通过（现有证据范围）**：`register.integration.test.ts:10-30` 覆盖独立 core + 注册 + DOM host 闭环和 schema 拒绝；报告另记录 capability runtime 12/12 通过，支持 allowlist 由既有 runtime 拒绝。
3. **部分通过**：`dom-host.identity.test.ts` 覆盖调用前取消、adapter 等待中取消后的迟到结果拒绝、DOM 替换、PageRef 三类失配和重复标签；未覆盖宿主并发重复写入，且实现确实无串行调度。
4. **通过**：报告记录包 build 通过；源码只依赖 core 类型与 DOM Web API，根导出可分别使用工具和 DOM adapter，没有 Chrome/React/Node 运行时 import。
5. **通过**：README 含 core 注册示例、`PageToolsHost` 扩展宿主说明、直接 DOM 用法、adapter 支持边界和 undo/外部副作用边界。

## C05 / C06

- **C05：未通过。** 原生字段、约束校验、不支持控件、逐字段失败和 `div` adapter fixture 均有实现与测试；但 adapter 可绕过 password/hidden 排除、无法接管原生受控元素，且回读偏离请求值时仍报告成功。
- **C06：未通过。** PageRef、元素身份、取消前检查和异步返回后复核均有证据；宿主本身没有写队列，并发重复写入可乱序，且页面事件处理器回退写入时无法用 `ok` 表达失败。

除上述四项外，未发现 Critical 或 Minor 问题。修复后应新增定向回归测试：敏感原生元素即使匹配 adapter 也不进入 snapshot；同一 host 的两个异步写调用严格按进入顺序执行；浏览器清洗值或事件回退时返回失败及实际值；显式 adapter 能接管允许适配的原生表单元素。
