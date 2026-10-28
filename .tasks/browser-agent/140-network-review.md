# 140 独立审查
只读，不改产品。任务140-network-preview.md；执行报告reports/140-report.md；范围diff reports/140-scope.diff；全局index.md。报告写reports/140-review.md。按Critical/Important/Minor给file:line证据，不重复已通过测试，可定向新疑点复现。逐条验收含任务末尾提前采集修正，尤其真正fixture初始化请求早于Agent、19工具共用装配、模型credential未进入业务Window、演示真实HTTP而非填充记录、stop/includeBuffered:false、UI生产边界、lock无升级、embedded文档。140 completion_requires120/130未done，先审本身实现，不能外推未验证上游。根CUA即将收口，当前未实测记为pending不伪造通过。

## R1 复审
执行报告reports/140-report-r1.md，窄diff reports/140-r1-scope.diff。根CUA实际证据reports/140-browser-check.md已通过，此前pending更新。只核原Important和变更引入的新问题，不重复已通过测试；写reports/140-review-r1.md。上游120/130未done，本叶自身review可先通过。
