# 220 编排验收

2026-09-20。功能源码由220实现，230独立只读审查PASSED；编排独立实际浏览器检查见220-browser-check.md。

- 实施：UI+extension 12 files/47 tests PASS；UI→extension build PASS；app noEmit tsc、docs、diff-check PASS。
- 最后仅历史操作测试补上真实details展开入口，定向BrowserAgentView 10/10 PASS，产品未再改动。
- 编排：根 `pnpm exec tsc -b --pretty false` PASS；`git diff --check` PASS。
- 行数：本轮大改/新增源与测试均<=300；既有BrowserAgentView.test.tsx现287行，其余本轮核心文件最高76行。
- 产物：重新生成ZIP，与dist逐文件及CRC/manifest比对PASS。extension ZIP 12 files / 1,017,404 bytes / SHA256 8835e764d8fa296f4e7b818046604f91527d975e464d4017edad637f09dc99d2。embedded headless demo内容未改。
- 原生Chrome已重载当前dist并实际显示新版侧栏，保存的ai录数会话可打开，在已有网站权限下重新绑定成功。没有模型请求、真实凭据输入或业务表单填写/保存，没有钥匙串访问。
- 独立230审查PASS，C01–C05覆盖齐全。宽/360/真实extension有图证；深色与极端缩放没有额外改系统设置实测，记录边界，不扩大声明。
- 本轮未commit/push、未远程建issue。
