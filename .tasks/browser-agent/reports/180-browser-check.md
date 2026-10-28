# 180 Apple HIG 视觉核验

日期2026-09-20。编排使用现有原生Chrome/CUA，不启动测试浏览器/CDP，不访问系统钥匙串。

## 改版前现场

CUA已观察到用户自行安装的Einfach Browser Agent（extension ID jlabenglclhfihpncpggbnolcjabkooo）侧栏在原生Chrome中打开。界面仍显示英文Page target/Bind active tab，两个重复层级的配置入口和空Agent/会话选择器。没有对当前业务页面输入、绑定或调用工具，没有读取/修改凭据。

本次在现有本地UI预览进行视觉核验；旧170待安装确认记录属于历史。已安装状态不代表授权当前业务网页工具执行。

## 新设计来源

GitHub: https://github.com/dickwu/apple-design-skill ，固定commit da2da6dd03aacf06da3fecf205347601d38bb141。
安装位置 /Users/dol/.codex/skills/apple-hig-design；原apple-design动效规范保留。180-skill-source.json记录来源和SKILL摘要hash。使用Web适用的HIG基础/布局/表单原则，不伪造原生macOS菜单或窗口，不运行仓库脚本。

## 改版后

CUA `getAXStateAndScreenshot` 已在当前会话输出三张实际画面（标题对应工具记录，非渲染模拟）：

1. “核验 360px 空态的真实渲染”：`?scenario=empty&width=360`，真实360px容器在桌面居中；单层导航，首配说明+单CTA；无空Agent/会话select。旧已装扩展仍在右侧，可以直接对照原绿灰表面和冗余控件。随后短标签从“模型”调整为“模型与 Key”，可访问名称不变。
2. “查看窄侧栏模型与 Key 配置”：点击实际首配CTA，显示连接名称、接口地址、模型ID列表、密码框、未配置状态和保存；无横向溢出或覆盖。没有输入真实凭据、没有保存配置。
3. “检查宽屏 Agent 配置与能力分组”：`?scenario=configured`，配置列表在左、编辑表单在右，工作说明与模型优先；工具/技能是带箭头和数量的折叠行。模拟业务iframe与本地请求演示仍存在，说明位于面板下方。产品与业务iframe样式隔离。

视觉判断：重复导航与无用首屏控件已移除，主要动作和次要动作区分，字段/帮助文层级清楚。表单字体与对比度参考180报告的数值核验。深色/高对比/减少动态只作源码与对比度审查，本轮没有改变用户系统偏好来实测。原生键盘与真实保存没有重复操作，既有user-event/真实client回归仍覆盖这些行为。

4. “确认新版扩展侧栏已实际生效”：在 `chrome://extensions/?id=jlabenglclhfihpncpggbnolcjabkooo` 只读确认已装来源为 `/Volumes/work/ai/web-agent/browser-agent/extension/dist`，点击“重新加载”（返回“已重新加载”），随后回到本地fixture并从扩展菜单打开已有插件。真实侧栏已显示中文“目标页面 / 创建会话后将自动绑定当前页面”、工作台头、四栏目（窄标签“模型与 Key”）、纯净空态。主页面同时保留宽屏 Agent 编辑页，所以同一张图可比较嵌入与侧栏的生产样式。没有创建会话/绑定页面/输入真实凭据/授予可选origin权限。

截图原始证据保存于本会话CUA工具图像输出，而非伪造文件路径。190先读到了更新前的报告而拒绝验收；后续复验需重新读取本报告。可通过现有原生Chrome只读截图独立检查当前宽屏配置与真实窄侧栏，不需要启动新浏览器或控制页面。

未操作用户业务网页，没有读写钥匙串。
