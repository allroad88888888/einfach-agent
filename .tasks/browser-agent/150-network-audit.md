---
id: '150'
title: 网络工具与提前采集覆盖可独立验收
kind: leaf
parent: browser-agent
depends_on: ['120', '130', '140']
model: gpt-5.6-sol
status: done
base: 756cd97
files: []
---
# 网络捕获覆盖与最终审查
只读产品代码，不修改产品，只写reports/150-review.md。读index、120/130/140任务与各执行/独立review报告，以及reports/network-final-scope.diff。逐条审查N01–N06，报告Critical/Important/Minor和准确file:line；无问题明确PASSED。不要重跑报告已通过的测试，可写临时定向复现到.tasks以确认新疑点，不发新HTTP/不启动浏览器/CDP、不访问钥匙串。
重点：用户要求页面打开即注入部分tool记录对话前请求，不应等start工具/打开侧栏才采集；已授予origin dynamic document_start MAIN加载，ISOLATED信任边界，native documentId固定避免导航竞态；页面prebuffer与会话capture隔离/限量/滚动过期，捕获原fetch/XHR不受损，payload敏感键先脱敏；真正fixture装配先发初始化请求后会话start，实际网络而非手工塞结果；独立host无UI，UI生产依赖未耦合具体tools。后启动无法补抓注入前body，真实MV3未浏览器验证需明确报告。
检视新增复杂性是否集中必要职责，没有新SDK层或无消费者抽象，普通源码/测试≤300行。两周边bug若与目标无关作为遗留，不顺手改。此任务也是横切覆盖审计，单元mock路由不能被写为真实MV3验收。报告需区分已证明/未证明的行为，勿预先压制质量问题。

最终最新证据：reports/120-report-r3.md、120-review-r3.md；130-report-r2.md、130-review-r2.md；140-report-r1.md、140-review-r1.md；network-final-verification.md、140-browser-check.md；network-final-scope.diff/sha256。当前无遗留质量发现；R3保守limiter允许释放严recorder后保留更小上限，这是任务明示的保守裁决。根最后176 tests/23 packed/类型/gates与R3源码一致，请只读审查不要重跑这些。
