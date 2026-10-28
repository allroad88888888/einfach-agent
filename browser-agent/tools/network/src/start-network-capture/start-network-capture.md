# start_network_capture
建立一个带独立过滤条件和停止生命周期的会话 capture 视图。页面基础记录器在扩展注入时已经开始；`includeBuffered` 默认 true，会把注入后积累的请求复制进该视图。无需过滤或停止控制时，可直接调用 `list_network_requests` 读取文档预缓冲。注入前历史无法补抓，观察不会重发请求。
