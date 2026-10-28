# 130 独立审查
只读审查产品，不改源码。任务：130-extension-network.md；执行报告：reports/130-report.md；范围diff：reports/130-scope.diff（均相对此目录）。全局index.md。
逐条验收含末尾最新用户提前采集要求，写reports/130-review.md。按Critical/Important/Minor分类，file:line证据；不得重复执行已有通过测试，可对新疑点做定向复现至.tasks。重点固定native documentId、防导航与取消竞态、错误返回不挂起、结果结构/大小校验、早期注册权限更新/恢复、复用120捕获/生命周期、真实mock范围准确。当前120未交付仍可变，130报告tsc阻塞不要视为130自身失败，但130验收不得外推120未证明行为。所有旧page改动是前轮已通过前态，network-prechange.diff可辅助归因。

## R1 复审
报告reports/130-report-r1.md，完整当前scope diff reports/130-r1-scope.diff。核原3Important+Minor+routeNetwork异步拒绝补修；写reports/130-review-r1.md。120 R1仍在改，公共合同不变；发现120依赖问题向root报告不要跨范围改，不重复已通过测试。根CUA已通过纯Web本地HTTP初始化请求/19工具，见reports/140-browser-check.md；仍非真实MV3实测。

## R2 复审
reports/130-report-r2.md 与 reports/130-r2-scope.diff。只核撤权dispose不能被pageshow复活、授权重新注入可用、合法空header值窄修，及直接引入问题。写reports/130-review-r2.md，不重跑已有测试。120公共合同保持，仍在R1。
