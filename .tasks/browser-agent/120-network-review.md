# 120 独立审查
只读产品，任务120-network-tools.md（含最新用户提前采集修正）；报告reports/120-report.md；diff reports/120-scope.diff；全局index.md。写reports/120-review.md，Critical/Important/Minor + file:line；不重复已通过测试，新疑点可.tasks临时定向复现。逐条对照完整host/recorder合同，不因只有10项测试就假定覆盖。重点先发请求后start、Request body保留、body有界/脱敏、fetch原this/参数/同Response/异常不变、XHR复用/事件/abort和json responseType、共享observer多host参数、stop/TTL真正卸载/读者listener清理、过期prune与导航/bfcache、includeBuffered false pending不混旧请求。所有普通source/tests正常多行排版，不能用2行承载整个测试/工具来规避300限制。独立判断缺陷，无需预先压制发现。

## R1 复审
reports/120-report-r1.md、reports/120-r1-scope.diff为当前源码。逐条验收原Critical/Important与R1直接引入的问题；读任务R1生命周期裁决。请勿重复跑已通过测试，更不能pnpm --dir... test误跑全仓；新增疑点可以.tasks限定复现且保存日志。报告reports/120-review-r1.md。130 R2与140 R1已独立通过，根CUA也通过。

## R2 复审
reports/120-report-r2.md 与 reports/120-r2-scope.diff，当前源码已严格冻结。只核4个Important和R2直接引入问题、pending Minor；包test cwd也修正。报告reports/120-review-r2.md，不重复已通过测试。

## R3 复审
新agent执行任务120-network-r3.md，报告reports/120-report-r3.md，diff reports/120-r3-scope.diff，源码冻结。只核原1项Important（recorder保守上限）及R3直接引入问题，写reports/120-review-r3.md，不重复已通过测试。完整合同不变：有recorder保守min、无recorder多host可增大collection且各capture独立限额，后续释放严格recorder不恢复宽上限是明确允许的保守行为。
