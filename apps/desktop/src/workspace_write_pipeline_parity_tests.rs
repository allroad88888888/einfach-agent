//! 对拍驱动器：单次写入的大小上限、可逆预算与守卫（带 IO）。
//!
//! 喂 `packages/host-node/fixtures/write-limits.json`，对面是 TS 的
//! `packages/host-node/src/parity/writeLimits.parity.test.ts`。
//!
//! 与 patch-pipeline / change-batch-revert 两组不同：`write_workspace_file` 只碰**一个**目标
//! 路径，没有「写完之后树里多一个文件」这类穷举风险，所以本组不做整棵树扫描，只读那一个目标
//! 文件——`fileContent` 为 `null` 表示这条路径不该存在（按设计拒绝的写入必须真的什么都没落盘）。
//!
//! 【WorkspaceWriteResult 是 snake_case，这是 W17 的坑之一】`workspace_write_result.rs` 没有
//! `rename_all`，顶层键是 `bytes_written` / `change_set` / `dry_run` 等；`change_summary` 嵌的
//! `FileChangeSummary` 自己带 `rename_all = "camelCase"`，所以同一份回执里外层 snake_case、
//! 内层 camelCase 混着来，fixture 照抄两种大小写，不要统一。

use super::write_workspace_file_blocking_with_journal;
use crate::parity_fixtures::{compare, run_cases, text_field};
use crate::parity_workspace::{seed_tree, ParityWorkspace};
use serde_json::Value;
use std::fs;

#[test]
fn write_limits_matches_the_shared_fixture() {
    run_cases("write-limits.json", |case| {
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
    let content = text_field(request, "content")?.to_string();

    let result = write_workspace_file_blocking_with_journal(
        path.clone(),
        content,
        optional_string_field(request, "mode"),
        optional_string_field(request, "expectedOldContent"),
        optional_string_field(request, "expectedContentHash"),
        optional_bool_field(request, "createDirs"),
        optional_usize_field(request, "maxBytes"),
        optional_bool_field(request, "exclusivePathLock"),
        Some(workspace.root.to_string_lossy().into_owned()),
        optional_string_field(request, "encoding"),
        optional_bool_field(request, "executable"),
        optional_bool_field(request, "dryRun"),
        None,
        "workspace-write-parity".to_string(),
    )
    .map_err(|err| format!("    写入流水线整条失败了: {err}"))?;

    let expected = &case["expected"];
    let actual = serde_json::to_value(&result).map_err(|err| format!("    序列化回执失败: {err}"))?;
    compare("回执", &actual, &expected["result"])?;

    let file_content = match fs::read_to_string(workspace.root.join(&path)) {
        Ok(text) => Value::String(text),
        Err(_) => Value::Null,
    };
    compare("目标文件内容", &file_content, &expected["fileContent"])?;
    Ok(())
}

fn optional_string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn optional_bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn optional_usize_field(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|value| value as usize)
}
