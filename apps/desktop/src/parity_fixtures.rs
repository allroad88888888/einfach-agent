//! 对拍 fixture 的加载与比对口径（Rust 侧）。
//!
//! `packages/host-node/fixtures/` 里的 JSON 由 Rust 与 TypeScript 两侧各自的驱动器读取，跑同一组
//! 用例。schema、分组与「新增一组要改哪几个文件」在那个目录的 README.md；本文件只管加载与比对。
//!
//! ## 为什么比对的是 `Value` 而不是序列化后的字符串
//!
//! 本 crate 的 `serde_json` 没开 `preserve_order`，`Value::Object` 底层是 `BTreeMap`，重新序列化
//! 时字段按 key 字节序**重排**；JS 那边 `JSON.parse` → `JSON.stringify` 保留插入序。两边逐字符比
//! 字符串必然假红。比 `Value` 则**键顺序不算差异、键的有无算差异**——后者正是要盯的东西：
//! `skip_serializing_if = "Option::is_none"` 让某个键整个消失，而没有该属性的 `Option` 写成显式
//! `null`，同一个结构里两种都有（`changeSummary` 是前者，`changeSet` 是后者）。
//!
//! ## 为什么一组 fixture 只占一个 `#[test]`
//!
//! Rust 没法在运行时按 fixture 展开出多个测试函数。所以 `run_cases` 逐例跑、**逐例收集失败**，
//! 最后一次性 panic 并列出每个失败用例的名字与差异——失败归因不会退化成「这组里有东西坏了」。

use serde_json::Value;
use std::{fs, path::PathBuf};

/// fixture 目录相对本 crate manifest 的位置。
const FIXTURE_DIRECTORY: &str = "../../packages/host-node/fixtures";

/// 读一份 fixture 的 `cases` 数组。读不到、不是合法 JSON、或一个用例都没有都直接 panic——
/// 那不是「被测代码有问题」，是对拍本身没跑起来，必须响亮地失败而不是静默跳过。
pub(crate) fn load_cases(file_name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(FIXTURE_DIRECTORY)
        .join(file_name);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读不到对拍 fixture `{}`: {err}", path.display()));
    let parsed: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("对拍 fixture `{}` 不是合法 JSON: {err}", path.display()));
    let cases = parsed
        .get("cases")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("对拍 fixture `{}` 里没有 cases 数组", path.display()));
    assert!(
        !cases.is_empty(),
        "对拍 fixture `{}` 里没有可跑的用例",
        path.display()
    );
    cases.clone()
}

/// 逐例跑一组 fixture，收齐全部失败再一次性报告。
pub(crate) fn run_cases(file_name: &str, mut run: impl FnMut(&Value) -> Result<(), String>) {
    let cases = load_cases(file_name);
    let mut failures = Vec::new();
    for case in &cases {
        let name = case
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("<未命名用例>");
        if let Err(reason) = run(case) {
            failures.push(format!("  · {name}\n{reason}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} 里有 {} / {} 例与 Rust 实现不一致：\n{}",
        file_name,
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// 比一个字段。不一致时把实际与期望都打出来——只说「不一致」等于让人重跑一遍加打印。
pub(crate) fn compare(label: &str, actual: &Value, expected: &Value) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "    {label} 不一致\n      实际: {actual}\n      期望: {expected}"
    ))
}

/// 取一个必填字符串字段。fixture 写错了是 fixture 的问题，报得出是哪个键才好改。
pub(crate) fn text_field<'a>(case: &'a Value, key: &str) -> Result<&'a str, String> {
    case.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("    用例缺少字符串字段 `{key}`"))
}

/// 取一个布尔字段，缺席按 `false`（fixture 里 `unixOnly` 之类的开关都是缺省即关）。
pub(crate) fn flag_field(case: &Value, key: &str) -> bool {
    case.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 取一个 `string | null` 字段：`null` 与缺席都是 `None`，其它类型是 fixture 写错了。
pub(crate) fn optional_text(value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        other => Err(format!("    期望 string | null，实际是 {other}")),
    }
}
