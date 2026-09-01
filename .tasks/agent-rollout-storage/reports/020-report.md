# 020 执行报告

状态：DONE

## R1 修复

- 按独立审查意见，将 `env` 校验下沉到 Windows 与 Linux 分支；macOS 只要求其实际依赖的 `homeDirectory`。
- Darwin table case 现在显式省略 `env`，覆盖该回归。
- R1 复验：定向 Vitest 11 passed、`pnpm exec tsc -b` 与 `git diff --check` 均通过。

## 完成内容

- 新增纯函数 `resolveAppDataDirectory(input)`，以显式注入的 platform、env、homeDirectory 与 customDirectory 解析 `com.webagent.app` 目录。
- 保持 macOS、Windows APPDATA/fallback、Linux XDG/fallback 的既有路径裁决；拒绝相对 custom directory。
- 缺失必需 env 或 homeDirectory 时抛出包含 platform 与缺失字段的错误，不读取真实用户环境。
- `resolveSqliteDatabasePath()` 复用共享目录解析；显式 `databasePath` 的优先级未改变。

## 验证

- `pnpm exec vitest run packages/host-node/src/appDataPath.test.ts packages/host-node/src/sqlite/databasePath.test.ts`：R0 11 passed；R1 见下方复验。
- `pnpm exec tsc -b`：通过。
- `git diff --check`：通过。
- 四个产品/测试文件均少于 300 行。

## 关注项

无。
