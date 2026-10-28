# 290 编排验证

- 执行者全UI回归：8 files / 30 tests，新增真实client undo/redo计数、运行中abort回填focus、同文本focus/拒绝保留草稿。报告290-report.md；没有重复重跑已通过的测试。
- 执行者 UI/extension build、tsc -b、check-docs 通过。编排另亲验 state/boundaries（290-root-state.log、290-root-boundaries.log）、embedded build（290-embedded-build.log）与 git diff --check 均通过。
- 编排检查最终 extension/dist/sidepanel.js 包含 refilledFrom/focusWhenReady 与 [busy,draft,refilledFrom] 修复，明确重做文案；上一轮 extension IIFE/权限/网络采集改动保留。
- 原生Chrome CUA 实测第二轮撤销回填focus、目标redo、全撤三入口、编辑多行草稿后恢复全部仍保留草稿；见290-browser-check.md。
- 新增/大改文件110/61/137行，各小于300。
- ZIP使用 package-network-artifacts.py 重新打包并逐文件字节比对/CRC/manifest一致：extension 12 files，1,030,692 bytes，SHA256 aaecd7cebc123f0aa7543917b2bd1c5df32af03b7f0cc513ba49925c9a46fd6b。embedded 68 files，835,244 bytes，SHA256 1ca6baa1626ad0145436917067429926aec71c476fb6c8bd1ec5f6633212ec69。
- 安装中的插件没有本轮重载，需用户重新加载扩展后读新dist；不改变网站授权。未发真实模型请求、未访问钥匙串、未操作客户对话/表单、未commit/push/远程issue。
