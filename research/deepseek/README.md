# DeepSeek 官方资料镜像

这里保存 DeepSeek 调研的可复现入口。原始网页、GitHub API 响应和浅克隆仓库写入
`sources/`，该目录已被 Git 忽略；同步脚本与结论文档进入版本控制。

## 同步

```bash
./research/deepseek/sync.sh
```

脚本会拉取：

- DeepSeek API Docs 英文与中文 sitemap 中的全部页面；
- `deepseek-ai` GitHub 组织全部公开仓库的元数据与 TSV 清单；
- 与本项目最相关的 `awesome-deepseek-agent` 浅克隆；
- `awesome-deepseek-integration` 的项目索引 README。

同步结果：

```text
sources/
├── api-docs/
│   ├── en/
│   ├── zh-cn/
│   ├── sitemap-en.xml
│   ├── sitemap-zh-cn.xml
│   ├── urls-en.txt
│   └── urls-zh-cn.txt
└── github/
    ├── deepseek-ai-repositories.json
    ├── deepseek-ai-repositories.tsv
    ├── awesome-deepseek-agent/
    └── awesome-deepseek-integration/
```

结论和实施顺序见 [`docs/deepseek-optimization-plan.md`](../../docs/deepseek-optimization-plan.md)。
