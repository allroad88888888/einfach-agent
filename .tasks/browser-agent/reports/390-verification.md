# DOM交互最终编排验证

日期：2026-09-21。370 R1与380 R1均独立APPROVED，产品源码已冻结。基线仍756cd97，保留此前全部未提交改动，无commit/push/远程issue。

## 最终命令与结果

- `pnpm exec vitest run browser-agent scripts/check-boundaries.test.js`：72files / 254tests全部通过，13.20秒，无失败/未处理错误。日志390-full-tests.log。此为本轮最终全browser-agent范围，非全仓core测试。
- `pnpm exec tsc -b`：通过，390-tsc.log。
- `pnpm --filter @einfach-agent/browser-extension build`：通过，390-extension-build.log。
- `pnpm --filter @einfach-agent/example-embedded build`：通过，390-embedded-build.log。
- 370最终page/dom build已通过且dom dist保留对page共享队列的外部引用。380先前UI build通过。本轮不改核心runtime/状态实现。
- `pnpm check:state`、`pnpm check:boundaries`、`node scripts/check-docs.js`通过，390-state/boundaries/docs.log（文档此时699份）。
- `git diff --check`通过；生产extension src/dist中fixture-cities/演示城市目录0命中。
- 新DOM包packed验证：首次系统pnpm7.33.7 pack报core workspace dependency not installed；检查发现新包缺本地core symlink。补现有仓库依赖的symlink，并使用已缓存pnpm10.17.1 pack成功，无install/网络下载/lock升级。报告390-dom-pack.log保留首次失败，390-dom-pack-final.log为最终成功。
- 对实际tgz解包，通过已有本地依赖链接验证ESM公开入口、六工具目录、普通div/span选择与回读；`node reports/390-packed-smoke.mjs`通过，390-packed-smoke.log。NodeNext直接消费实际产物d.ts类型检查通过，390-packed-types.log。解包首次用了旧Python不支持的filter参数，改为本地tar成员路径/类型验证后成功；未改产品规避。
- ZIP打包CRC、逐文件对比dist、manifest一致性全部通过。extension ZIP 12files/1089738bytes SHA256 ad6ff077af253514d8c42c30f9bbec01e3ee10b8638c394751b8f2948d9ec22d；embedded ZIP 68files/864475bytes SHA256 6ea8e77eac0183b03c9bddd4bcfc91541fa159217f78918be28bcec680144fe4。artifacts/checksums.json同步。

## 覆盖矩阵

| ID | 证据 | 结果 |
|---|---|---|
| D01 | 370-report/review；DOM源码29files/76tests含page；CUA普通div/span异步弹层链 | PASS |
| D02 | 370 R1阶段abort/replace、祖先禁用、fieldset首legend、ARIA行为、native select、共享队列测试与review | PASS |
| D03 | 380 R1真实bridge→service→content六方法组合，取消/导航/错页/畸形返回；最终bundle与原bundle隔离测试 | PASS（真实MV3业务未实测） |
| D04 | 双iframe/session真实core mock模型消费各自PageRef+回读；CUA真实registry五步；配置25项含六DOM | PASS |
| D05 | 新包workspace/边界、生产无fixture来源、packed ESM+d.ts、无UI嵌入与extension产物 | PASS |
| D06 | 全相关组合、构建、CUA、双叶独立审查；最终390独立审计APPROVED、零发现 | PASS |

## 用户可用范围

新包不依赖React/Chrome，DOM工具供extension和embedded共用；同一Document保持既有PageRef/取消/写队列。通过DOM观察元素引用，点击、输入、按键、滚动、等待，完成选后业务回读；不猜底层value。扩展清空演示城市来源但保留API工具名兼容用户旧配置。

已存Agent和会话不会被暗中扩展工具权限；使用新版需重载扩展、刷新目标网页，在设置→Agent勾选DOM能力并新建会话，遵循既有能力快照语义。本轮没有自动覆盖真实配置、使用模型Key、调用真实模型或提交业务工单。

真实CUA只在现有Google Chrome完成本地fixture与配置入口验证，详见390-browser-check.md。真实客户站点MV3新工具选择未实测；不把fixture当成该项通过。纯DOM合成事件isTrusted=false，跨源iframe/closed shadow和可信键盘默认动作不在本次范围。原业务标签未修改。所有源码变动局限370/380范围，其他旧未提交工作保留。

最终独立终审390-review.md APPROVED，D01–D06全PASS、零质量遗留；最后文档检查701份通过（终审报告入账后再核）。全部必要工作已完成。
