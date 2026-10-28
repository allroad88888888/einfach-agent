# 240 编排最终核验

- 已逐读 targeted history API、sessionTurnHistory投影、消息动作渲染及CSS；修正了按钮CSS specificity与占位父级opacity问题，R1新增键盘禁用原因可达性。
- 编排亲自执行最终 `pnpm exec tsc -b --pretty false`、`node scripts/check-docs.js`、`git diff --check`，全部通过；docs共642 Markdown。
- 执行者报告真实core/UI等41项回归通过，R1 UI 16项通过；最后仅CSS对比修改后消息动作4项通过。不是将重叠测试次数相加冒称独立覆盖。
- core/runtime/UI/extension与根build通过；编排另外重建headless embedded demo，确保同批分发包含新core。
- 最终ZIP逐文件与dist字节相等、CRC通过、manifest等于源码。Extension：12文件，1,022,111字节，SHA256 `10a0486143a8e981e1deb7954fd7d804076883736415aa2cdf454ea905f105d5`。Embedded：68文件，831,092字节，SHA256 `9697756216a9ebf032f18f8455c501c63c01dd0cb58d87dcdb562dd141a66c7a`。
- 原生Chrome已实点360px第二轮undo并截图验证第一轮保留、后两轮就地占位；其余浏览器范围与未热重载插件见240-browser-check.md。
- 不install、不改lock、不访问钥匙串、不动真实模型凭据、不创建远程issue、不commit/push。既有未提交修改保留。
