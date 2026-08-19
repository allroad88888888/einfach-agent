//! 对拍驱动器：字节/行读取的容量上限、越界与截断（带 IO）。
//!
//! 喂 `packages/host-node/fixtures/read-limits.json`，对面是 TS 的
//! `packages/host-node/src/parity/readLimits.parity.test.ts`。
//!
//! 走的是 `read_workspace_file` 的**顶层分派** `read_workspace_file_blocking_at_lines`，不是直接
//! 调字节或行两个子实现——分派本身（两个行参数都缺席才走字节模式、offset 与 startLine 冲突
//! 判定）也是要盯的行为。
//!
//! **读不改磁盘**，所以本组不做落盘后文件树的收尾断言，只比结果或错误文案。
//!
//! 【错误文案里带 resolved 绝对路径的用例一律不进本组】`display_path` 在越界类错误里报的是
//! canonicalize 之后的绝对路径，而两侧的临时 workspace 目录命名各不相同，没有任何机制能让它们
//! 生成同一个字符串——这条豁免与「OS 错误串」是并列的第三条，见 fixtures/README.md。

use crate::parity_fixtures::{compare, run_cases, text_field};
use crate::parity_workspace::{seed_tree, ParityWorkspace};
use serde_json::Value;

#[test]
fn read_limits_matches_the_shared_fixture() {
    run_cases("read-limits.json", |case| {
        let workspace = ParityWorkspace::create();
        let outcome = run_case(case, &workspace);
        workspace.cleanup();
        outcome
    });
}

fn run_case(case: &Value, workspace: &ParityWorkspace) -> Result<(), String> {
    seed_tree(&workspace.root, &case["initialFiles"])?;

    let request = &case["request"];
    let path = text_field(request, "path")?.to_string();
    let max_bytes = optional_usize_field(request, "max_bytes");
    let offset = optional_u64_field(request, "offset");
    let start_line = optional_usize_field(request, "start_line");
    let line_count = optional_usize_field(request, "line_count");
    let workspace_root = Some(workspace.root.to_string_lossy().into_owned());

    let outcome = super::read_workspace_file_blocking_at_lines(
        path,
        max_bytes,
        offset,
        start_line,
        line_count,
        workspace_root,
        false,
    );

    let expected = &case["expected"];
    match (outcome, expected.get("result"), expected.get("error")) {
        (Ok(result), Some(expected_result), None) => {
            let actual = serde_json::to_value(&result)
                .map_err(|err| format!("    序列化回执失败: {err}"))?;
            compare("回执", &actual, expected_result)
        }
        (Err(message), None, Some(expected_error)) => compare(
            "错误文案",
            &Value::String(message),
            expected_error,
        ),
        (Ok(result), None, Some(expected_error)) => Err(format!(
            "    期望被拒绝（{expected_error}），实际读取成功: {result:?}"
        )),
        (Err(message), Some(expected_result), None) => Err(format!(
            "    期望成功（{expected_result}），实际被拒绝: {message}"
        )),
        (_, expected_result, expected_error) => Err(format!(
            "    fixture 的 expected 必须恰好给 result 或 error 之一，实际 result={expected_result:?} error={expected_error:?}"
        )),
    }
}

fn optional_usize_field(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|value| value as usize)
}

fn optional_u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}
