# list_network_requests
分页列出请求摘要。省略 `captureId` 会读取页面记录器从注入时开始积累的文档预缓冲；返回的 `captureId` 可继续读取请求与响应详情。传入 `captureId` 则读取显式 capture 视图。默认 20 条、最大 100 条，结果会区分文档预缓冲与显式 capture，并报告真正的记录开始时间和容量淘汰计数。
