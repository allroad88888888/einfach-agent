# list_options_sources

先调用此工具发现当前会话可以使用的业务选项数据源。返回的 `id` 可直接作为
`query_options.sourceId`；`label` 和 `description` 只帮助选择合适的来源。

可选 `offset` 从零开始分页，`limit` 默认 20，范围为 1 到 100。空列表表示当前会话没有获授权的数据源。
该工具不会发起业务查询，也不会显示接口地址、请求头、凭据或其他宿主配置。
