# read_field_options

读取 `read_form` 标识字段当前已在 DOM 暴露的候选项，可按标签或稳定值过滤并分页。工具不会打开下拉框或加载远程候选。

结果的 `optionsStatus: "exposed"` 表示读取了当前已渲染集合。只有显示文本而没有稳定 value 的候选仅返回 `label`。`optionsStatus: "not-exposed"` 会受控失败，避免把“尚未打开”误报为真正的空列表。

对于 `supported:false` 或挂到 `body` 的非原生弹层，改用 `read_dom` 观察控件、`click_dom` 展开，再用 `wait_for_dom`/`read_dom` 读取实际候选。点击精确候选引用后回读目标显示值；显示标签不等同于站点未公开的业务 value。
