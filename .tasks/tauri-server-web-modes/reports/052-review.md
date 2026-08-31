# 052 独立审查

结论：**REJECTED**

实现已用 TypeScript symbol 解析替代按名称收集常量，普通赋值、`++/--`、词法 shadowing、声明顺序和递归常量求值的主路径均符合目标；可信插件箭头的既有特例也未见退化。但 mutation 判定只识别“identifier 本身就是 binary expression 左操作数”的写入，漏掉解构赋值与 `for..of/in` 写入目标。分析器仍会把这些已写入的 `const` binding 当作旧静态字符串折叠，导致动态 import 和 computed global require alias 返回空 violations，违反“未被赋值/update”与 conservative failure 的明确要求。

按要求未重跑执行报告已经运行的测试；仅用定向调用 `inspectWebSource()` 验证下面的静态语义反例。审查依据为任务、执行报告，以及两个 untracked 产品文件相对 `/dev/null` 的完整 diff。

## 验收标准

1. ⚠️ 报告声明 `node apps/desktop/tests/desktopStaticGuard.test.mjs` 为 4/4 通过；按审查要求未重跑。现有测试通过不能覆盖下述缺口。
2. ❌ mutation 与词法 binding 语义不完整。普通 `let` mutation、直接 assignment、update、shadowing 和先使用后声明已有夹具；但解构/迭代写入可让非静态 import 与 computed require alias 漏报。
3. ✅ 代码复核显示直接 `const` 拼接、模板常量、透明 wrapper 与唯一可信插件 `evaluate` 仍保持原契约。
4. ⚠️ 报告声明 wrapper 检查通过且范围/ignored artifacts 字节不变；按要求未重跑。
5. ✅ 两个文件分别为 229、236 行，均不超过 300 行；静态分析器与守卫测试各自职责单一。报告声明 `node --check` 和范围 `git diff --check` 通过，未重跑。

## 质量发现

### Critical

无。

### Important

1. **解构与迭代赋值不会把 binding 标记为 mutated，存在确定性漏报。** `webCapabilityStaticAnalysis.mjs:149-158` 仅在 identifier 的直接 parent 是 assignment binary expression 且该 identifier 等于整个 `parent.left` 时识别赋值；identifier 位于 object/array assignment pattern 或 `for..of/in` initializer 时均不满足。随后 `:169-185` 仍会从旧 initializer 折叠该 symbol。定向探针确认以下四段源码均返回 `[]`：

   ```ts
   const target = './safe.js'; ({target} = attackerControlled); import(target)
   const key = 'safe'; ({key} = {key: 'require'}); (globalThis[key])(source)
   const target = './safe.js'; [target] = attackerControlled; import(target)
   const target = './safe.js'; for (target of attackerControlled) {} import(target)
   ```

   这与现有 `const target++; import(target)` 夹具属于同一验收模型：即使 TypeScript 会诊断对 `const` 的写入，静态守卫当前仍主动扫描可解析源码且任务明确要求 binding “未被赋值/update”才可折叠，因此不能只覆盖直接写入。建议以 TypeScript AST 的 assignment-target 祖先关系完整识别 binding 写入（含嵌套 object/array pattern 与 `for..of/in`），并为动态 import、computed global require 各补至少一个解构 mutation 反例。

### Minor

无。

## 最终判定

**REJECTED**。验收 2 的 mutation/conservative-failure 边界仍有可复现漏报，修复并补回归夹具后再审。
