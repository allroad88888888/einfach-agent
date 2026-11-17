# @einfach-agent/tools-search

提供 `deepseek_search` 工具，通过 DeepSeek 官方 `POST /v1/tools/search` 搜索网页。
该工具已加入 `registerStandardTools`，Web、桌面、CLI 均复用 DeepSeek 模型凭证，无需额外搜索 Key。

嵌入方可单独调用 `registerSearchTools(core.tools)`，并注入
`core.config.webSearch = createDeepSeekSearch({ apiKey, fetchImpl })`。
Web 的 `fetchImpl` 使用宿主管理的模型代理；CLI 可使用原生 fetch。

支持 query、count、ori_question、localization、need_content；详见[工具指南](src/deepseek-search/deepseek-search.md)。
官方接口说明：https://api-docs.deepseek.com/zh-cn/guides/search/
