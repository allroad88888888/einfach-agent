# 180 编排验证

执行者已完成 UI + extension 10 files / 36 tests、UI build、extension build、app tsc、state、boundaries、docs，详见180-report.md。编排正在执行全browser-agent+boundary回归。CUA已完成360空态与模型表单截图；宽屏配置页核验进行中，稍后更新180-browser-check.md。

编排亲验：`pnpm exec vitest run browser-agent scripts/check-boundaries.test.js`：48 files / 179 tests 全通过，7.82秒；包含本轮UI与原page/api/network/extension回归。

编排根 `pnpm exec tsc -b` 通过。UI源码10:35:17、UI dist10:35:32、extension dist10:35:33；安装来源已核为repo extension/dist，原生Chrome刷新后实际新版侧栏通过。

最终静态检查：`git diff --check`通过，文档检查623 Markdown通过。ZIP打包执行逐文件比对与CRC校验；180深色目标条hover窄修后会再次更新extension ZIP与checksums。

最后CSS窄修已完成并重建extension，产品源码与范围diff已刷新。最终extension ZIP为12文件，SHA-256 `30be97e7101856dbaffd990d9b5610152db517234598ec62fe636f3fcfca2e01`，CRC及逐文件与dist比对通过。
