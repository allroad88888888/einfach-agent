# 真实 Chrome 插件验收准备

2026-09-19，用户在160收口后要求继续。

- 已核对任务树：全部源码实现叶完成；真实MV3网络桥/提前注入及最新配置视图在日常原生Chrome中的组合实测仍属于已记录未验证项。
- 编排经CUA查看当前原生Chrome的 chrome://extensions：开发者模式已开启，当前列表没有 Einfach Browser Agent；没有修改其他扩展或浏览器设置。
- 最新本地构建路径：`/Volumes/work/ai/web-agent/browser-agent/extension/dist`。插件ZIP重新核对SHA256、CRC、所有12文件与dist字节一致。
- 下一步加载此未上架本地构建，打开侧栏，只用本地测试页面与测试凭据验证。没有真实模型Key/客户页面，不宣称真实服务连通。
- 当前停在安装前：CUA Computer Use Confirmation Policy 的“Installs or runs software from an unrecognized source”（工具文档定义包含官方商店/供应商/包仓库之外来源）要求实际安装前确认。现有任务授权涵盖开发、构建与测试，但没有明确允许安装到当前日常Chrome。
- 等用户确认的具体动作：将上述dist加载进当前Chrome；不授权任意客户网站、不触碰系统钥匙串。未安装/未赋予页面权限，不将本记录算作实机验证通过。
