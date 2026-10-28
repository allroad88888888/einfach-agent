# 260/270 编排最终核验

260 page 43测试、270 network 40测试、最终extension 33测试通过；执行报告分别记录就近场景。270 R1新增可复验真实产物脚本（先build后classic eval两次并验证早期request/response），非仅配置字符串检查。

编排亲自执行根`pnpm build`（日志260-270-root-build.log）、`pnpm check:state`、`pnpm check:boundaries`、`node scripts/check-docs.js`、`git diff --check`，全部通过。额外重建embedded（260-270-embedded-build.log）。新增标题模块80行、host279行；observer320行是单个强内聚hook状态机窄增，按已记录500上限例外审查。

已安装Chrome扩展实际重载，旧权限保持cloud.deepfos.com；原生全桥验证详见260-270-browser-check.md：七字段标题正确、无start读取26条、重复连接保26条与监听时刻、响应正文可读。已关闭编排临时诊断页，不操作用户其他页面。没有真实模型请求、业务写入、安装或钥匙串操作。

最终分发ZIP逐文件比对dist、CRC与manifest校验通过：

- extension：12文件，1,029,654字节，SHA256 `6a928da1352e6e287bf0753b15c6cf041ccbaa7d3bb95a6caebd53faa7f3db54`。
- embedded：68文件，835,244字节，SHA256 `447b7830d04816c707f98748056b7b8f080d225370e10e21cbcf7bac23fd05e2`。

280独立审查PASSED。能力边界仍是已授权主文档fetch/XHR，有界记录；资源请求/跨frame/worker尚未扩展，用户可选范围未答，不冒称所有浏览器网络。所有修改本地保留，未commit/push，已有lock增量未改。
