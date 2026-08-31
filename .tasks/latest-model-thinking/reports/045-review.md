# 045 独立审查：续接 Kimi K3 图片链路

结论：**APPROVED**。

## 审查范围

- 以 `98816b041b42d55ee3308a909af8e8cf7f646f36` 为 base；当前 `HEAD` 与 base 相同。
- 已完整阅读任务消息内嵌的 `AGENTS.md` 规则、`one-file-one-thing` skill、`index.md`、
  `045-kimi-k3-images.md`、`reports/045-report.md` 与 `reports/040-review.md`。仓库文件系统中没有实际
  `AGENTS.md`（`rg --files` 与 `find .. -name AGENTS.md` 均未在本仓库找到），故以任务消息内嵌规则为准。
- 只审查 045 任务卡列出的文件；按账本批准纳入 `builtinModelDescriptors.ts`。该文件同时含 040 的未提交
  差异，本审查只把 K2.6 image capability import/consumer 改为 K3 的两处变化归入 045，其余 K3 目录与
  Thinking 差异沿用已经批准的 040 结论。
- 040 同批文件、后续 055 夹具、`.gitignore`、`.project-lines/`、`CLAUDE.md`、UndoBar、CSS、
  `apps/desktop/gen/` 等既有脏改不属于本审查范围，未修改、未误报。
- `kimiFiles.transaction.test.ts` 在 base 已存在且不属于 045 diff；仅作为既有事务回归一并复跑。
- 本审查没有修改产品代码或测试，只新增本报告。

## 按严重性 findings

### Critical

无。

### Important

无。

### Minor

无阻断性代码或测试发现。

### Informational

1. 生产 TS/TSX（排除测试、任务账本与生成物）未命中 `KIMI_K2_6`、`kimi-k2.6` 或 `Kimi K2.6`。
   当前命中只位于 README、历史设计文档及 055 明确负责的退役测试夹具，不属于 045 生产代码残留。
2. `kimiFiles.test.ts` 新增的显式 rollback 用例与 base 中专责的
   `kimiFiles.transaction.test.ts` 都验证幂等删除；有少量覆盖重叠，但文件仍分别低于 300 行，且没有形成
   不同业务层面的职责混杂，不阻断批准。

## 验收标准逐条判定

1. ✅ **K3 CN 上传、`ms://` 编码与 region 一致。**
   - `imageCapability.ts:22-32` 只导出 K3 命名的 provider-upload capability；
     `builtinModelDescriptors.ts:35,111-117` 让精确 `kimi-k3` descriptor 消费该 capability，不保留
     K2.6 生产 alias。
   - `kimiFiles.ts:66-73,91-96` 在 transport 前只允许 `cn`，并由同一 region 推导 Moonshot `/files`
     endpoint；`kimiFiles.ts:108-121` 白名单校验 file id 后生成 `kimi:cn` scope 与 `ms://<id>`。
   - `kimiMessages.ts:35-55` 再次要求精确模型有图片能力、provider 为 Kimi、scope 与 request region
     一致、reference 是合法 `ms://`，再投影为 `image_url`。
   - 注入 fetch 的测试固定了 CN URL、multipart、选择顺序、`kimi:cn` scope、合法 `ms://` 输出以及
     K3 message wire。

2. ✅ **部分失败、取消与显式 rollback 均清理，且最多一次。**
   - `kimiFiles.ts:131-141` best-effort 删除全部已成功上传的文件，故 cleanup 失败不会遮蔽主失败；删除
     故意不复用已经 abort 的 signal。
   - `kimiFiles.ts:152-158` 等待并收集并发上传结果，部分失败或 signal 已取消时只进入一次 cleanup；
     `kimiFiles.ts:160-167` 在 await 前设置 `rolledBack`，串行或并发重复 rollback 都不会二次删除。
   - `kimiFiles.test.ts:68-147` 的精确数组/方法序列分别固定部分失败、取消、两次显式 rollback 的删除
     次数；既有 transaction 测试同时保持通过。

3. ✅ **K3 历史图片可消费；跨 provider/region/非法引用降级。**
   - `historyImageCompatibility.ts:45-61` 只让精确 `DEFAULT_KIMI_MODEL`、Kimi provider、匹配 scope 与
     合法 `ms://` 成为 consumable，其余返回带明确 reason 的 placeholder。
   - `historyImageCompatibility.test.ts:33-52` 固定 K3 正常消费、未知 Kimi model、跨 region 与非法引用；
     同文件的跨 provider 用例固定 placeholder，`kimiMessages.test.ts` 又在最终 wire 边界拒绝 foreign
     provider、错 region 与非法 URI。
   - Web guard 专项确认匹配 K3 历史图片不会封锁 Composer，不兼容历史仍显示警告且不泄露私有引用。

4. ✅ **global 保持禁用。**
   - `kimiFiles.ts:66-69` 在任何 fetch 前拒绝 global；`providerImageBatch.ts:37-48` 在宿主 adapter
     边界也只允许 CN。
   - 注入 fetch 的 global 测试断言错误返回且 fetch 零调用，没有借 K3 升级开放全球区上传。

5. ✅ **专项、类型、state/boundaries、diff 与文件规则通过。**
   - 独立复跑 7 个专项文件为 32/32；`tsc -b`、`check:state`、`check:boundaries` 均 exit 0。
   - 全工作树 `git diff --check` 无输出；045 范围 diff 也无尾随空白。
   - 任务卡 12 个文件物理行数依次为 126、44、28、177、229、75、95、101、72、78、177、64，最大
     229 行，全部低于普通文件 300 行硬上限。各文件仍可用一个业务点或抽象描述，没有假拆分或大杂烩。

## 命令证据

```sh
git rev-parse HEAD
# 98816b041b42d55ee3308a909af8e8cf7f646f36

pnpm exec vitest run \
  packages/agent-ai/src/imageCapability.test.ts \
  packages/agent-ai/src/kimiFiles.test.ts \
  packages/agent-ai/src/kimiFiles.transaction.test.ts \
  packages/agent-ai/src/kimiMessages.test.ts \
  packages/agent-ai/src/historyImageCompatibility.test.ts \
  apps/web/src/modelInput/prepareProviderUserInput.test.ts \
  apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.test.tsx
# 7 files passed; 32 tests passed

pnpm exec tsc -b --pretty false
# exit 0

pnpm check:state
# exit 0; 5 rules passed; scanned 22 workspaces / 902 non-test TS/TSX files

pnpm check:boundaries
# exit 0; 7 rules passed; scanned 918 non-test TS/TSX files; only existing exemptions

git diff --check
# no output

rg -n -i "KIMI_K2_6|kimi-k2(?:\\.|-|_)?6|Kimi K2(?:\\.|-|_)?6" \
  --glob '!**/*.test.*' --glob '!**/*.spec.*' --glob '!.tasks/**' \
  --glob '!apps/desktop/gen/**' .
# only README/docs hits; no production TS/TSX hit

wc -l <045 task files>
# max 229; all 12 files <= 300
```

## Coverage 结论

- **C-08：满足。** 精确 K3 capability、CN 上传、`ms://` wire、region/scope 双边校验、历史消费与
  placeholder、部分失败/取消/rollback cleanup 均有实现与专项测试证据。
- **global 限制：满足。** agent-ai 与 Web adapter 两层均在 transport 前拒绝 global 上传。
- **旧标识收口：满足 045 范围。** 045 生产链路与其 K3 descriptor consumer 无 K2.6 标识；范围外旧测试
  夹具仍按计划留给 055。
- **回归门：满足。** 专项、types、state/boundaries、diff 与 300 行/SRP 检查全部通过。

## 最终判断

045 已把 K3 descriptor、图片 capability、CN 上传、消息编码、历史兼容与清理事务闭合；global 未被
放开，旧 K2.6 生产别名已移除，且所有本叶验收门通过。批准。
