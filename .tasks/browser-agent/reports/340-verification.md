# 340 编排验收

状态：PASSED。340 R1经350-review.md独立通过；360-review.md独立通过。无遗留质量项。

## 功能证据

- U10/U12：createHistory公开cap覆盖所有可实现JS数组长度，不再有应用级事务/年龄淘汰；仍用原有SESSION_SLOTS逆操作。1205用户消息+中段contextCheckpoint=1206事务，persist→新core hydrate→最早撤回后items为空、checkpoint还原。早/中/末消息均无history_unavailable。
- U11：snapshot.history与state同捕获同原子saveLatest；延迟save、连续generation、不可序列化账本、损坏cursor/entry/ops/barrier及legacy配对由340报告的真实回归覆盖。新历史不再异步另写外置账本，旧driver读取/删除兼容保留。
- U13：每消息undo/成功回填聚焦/拒绝保草稿仍在，正常历史无“超出可撤销历史”期限文案；redo/撤销占位未加回。旧版已裁掉的entry不可凭空补全。
- U14：stop时仍被历史引用的上传保留；丢弃redo分支后最终不可达资源释放；删会话保护其他session共享引用。旧真实不可逆屏障不绕过。

## 最终验证

- 执行定向初轮12files/65tests，R1最终2files/13tests；完整相关范围最终261files/2078tests通过，`360-full-final.log`无unhandled errors。
- 360最终helper初始化同步回调防护修改之后又定向2files/11tests通过（360-targeted-final.log）；此前并行tsc负载10轮均通过。没有修改pluginHost/defaultPlugins产品runtime。动态import异常精确内部根因未独立证明，不声称基线缺陷。
- 编排亲验`pnpm build`最终成功，日志340-root-build.log；core build 340-core-build.log；IDB/browser agent/UI build 340-packages-build.log；extension/embedded build 340-extension-build.log / 340-embedded-build.log均成功。
- state/boundaries/diff门禁通过，日志340-state.log / 340-boundaries.log；最终docs检查也通过。
- extension ZIP：12 files，1042869 bytes，SHA256 b613308c02ecc1c144c6a66b2bfd2bbc154fb685b5ab5086e4be3440a33e8a2c。
- embedded ZIP：68 files，846279 bytes，SHA256 0df3b7a7af9ff6db8110a9154e1b58a3e5e3a7fb22136814248cb116da93b6a8。
- 两ZIP逐文件与dist对比、CRC及manifest校验均通过；artifacts/checksums.json已更新。

## 证据边界

原生Chrome本轮及收尾getApp均返回cgWindowNotFound，未操作用户真实会话的undo、未发真实模型请求、未触碰钥匙串。安装实例尚未重载本轮产物，需重载扩展并刷新业务文档。当前实测为真实core/持久化driver及UI测试，不冒充原生浏览器实测。

340-delta对照340-before精确收录本轮修改，最后两集成测试等待修改属于360，另有360-delta.diff。所有旧增量保留，无commit/push/远程issue。
