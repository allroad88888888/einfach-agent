# 工具扩充最终验收上下文

追加080/090/100共新增7个工具，完整配置页13个。三个叶均独立PASSED：080-review-r1.md、090-review-r1.md、100-review.md。100-browser-check.md是编排CUA真实可见证据。完整增量tools-final-scope.diff含新未跟踪源码，排除旧UI截图reports。

## 已通过

- 080最终38项页面包测试与build，090最终26项API包测试与build；两个范围旧用例均包括。
- 100所有桥/预览工具调用、隔离iframe、catalog13项、旧host兼容、嵌入公开包接线验证。
- tools-final-types.log：根tsc -b通过。
- tools-final-app-build.log：最终page R1 build之后，extension/embedded重新构建通过。
- tools-final-state-r1.log、tools-final-boundaries.log、tools-final-docs.log：状态/包边界/文档门通过。

## 正在核实的组合问题

首次browser-agent整体106测试有旧client.integration测试固定30ms等待失败，单独复验8/8通过；最终低并发107测试105通过，client与multiClient旧用例失败伴随defaultCorePlugins is not iterable异步异常。tools-final-tests.log、tools-client-recheck.log、tools-final-tests-r1.log保留失败与复验。

编排正在临时worktree基线756cd97复现，结果写tools-baseline-tests.log，不能在结论中声称全组合已通过。新增工具及桥测试全部通过，没有修改agent/core运行代码。若基线同样失败，按证据记既有问题；若本次引入，则需修复。

## 范围与遗留

110交付补充：reports/110-report.md、110-scope.diff记录仅两个测试的终态等待修复，110-targeted.log为11/11通过，110-browser-agent.log为默认并发27files/107tests通过且无unhandled errors。未改产品core/agent运行代码、未预加载插件、未放宽原断言。此前失败日志保留；110独立审查与整树最终结论待终审回写。编排最终tools-final-types-r1.log根tsc通过，tools-final-dist.log通过22 packed包/32 ESM入口、CSS、NodeNext声明及负导出检查。

只在两个既有工具包增加业务工具，不增加SDK/宿主层；可选UI独立不依赖具体工具生产包，fixture通过devDependencies引用。无任意JS、任意URL请求或最终业务提交工具。没有请求/操作系统钥匙串，没有启动测试Chrome，没有远程issue，没有本轮commit/push。真实客户站点/API与Edge未验证，沿用第一版范围。
