# cache-investigation

F1/F2/F6 上下文缓存验收的一键报告。验收标准与背景见
[docs/context-cache-followups.md](../../docs/context-cache-followups.md),
回归案例见 [docs/context-cache-regression-observation-2026-08-04.md](../../docs/context-cache-regression-observation-2026-08-04.md)。

```bash
# 全量(默认读桌面库,复制 db+wal 后离线查询,不影响运行中的应用)
node scripts/cache-investigation/report.js

# 只看某天之后 / 某个 run
node scripts/cache-investigation/report.js --since 2026-08-04T00:00:00+08:00
node scripts/cache-investigation/report.js --run 95a0307a-544a-4e3e-a96a-0e5c3f47a9be
```

输出四段:

1. **F1**:每 run 压缩/延伸/复用计数、每次重压摊到的复用轮数、按 (scope, epoch)
   去重的真实失效(F2 的 `history_inserted_before_dynamic_tail` 归零也看这里)。
2. **F6**:工具集变化步数(基线:均值 1.94、最大 9)与 schema 加载事件。
3. **加权命中率**:供应商 usage 的 token 加权 hit rate(历史基线 63.9%),用于和
   DeepSeek 控制台账单对账。
4. **前缀稳定性**:同 run 相邻轮 `requestPreview` 窗口内逐字节对比。窗口内稳定而
   供应商仍报低命中 ⇒ 供应商侧因素(best-effort 路由/建缓存延迟),不是本地请求不稳定;
   压缩/延伸轮出现的分歧属预期,报告会附该 run 的重压次数供对照。

指标计算在 `lib.js`(纯函数,配 `lib.test.js`);IO 与展示在 `report.js`。
