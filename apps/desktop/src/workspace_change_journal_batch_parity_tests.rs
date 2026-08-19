//! 对拍驱动器：变更日志的批量回滚（带 IO）。
//!
//! 喂 `packages/host-node/fixtures/change-batch-revert.json`，对面是 TS 的
//! `packages/host-node/src/parity/changeBatchRevert.parity.test.ts`。
//!
//! 驱动器直接调**批量**入口 `revert_change_sets_blocking`，不经命令层「一条走单条、多条走批量」
//! 的分流——fixture 抽自 workspace_change_journal_batch_tests.rs，测的就是批量那条路。
//!
//! 【账本按数组顺序登记，于是数组顺序 = createdAt 升序】批量执行顺序由 `created_at` 决定而不是
//! 调用方传的 id 顺序，所以「登记顺序」是 fixture 的一部分：`changeSets[]` 的先后就是账本的先后，
//! `revert.changeSetIds` 才是调用方的说法。两者故意可以不一致（有一例正是拿它当被测对象）。

use super::*;
use crate::parity_fixtures::{compare, flag_field, optional_text, run_cases, text_field};
use crate::parity_workspace::{read_entry_status, read_tree, seed_tree, ParityWorkspace};
use crate::workspace_change_journal::prepare::{mark_change_applied, prepare_change_set};
use crate::workspace_change_journal::types::{ChangeFileInput, WorkspaceChangeContext};
use serde_json::Value;

#[test]
fn batch_revert_matches_the_shared_fixture() {
    run_cases("change-batch-revert.json", |case| {
        let workspace = ParityWorkspace::create();
        let outcome = run_case(case, &workspace);
        workspace.cleanup();
        outcome
    });
}

fn run_case(case: &Value, workspace: &ParityWorkspace) -> Result<(), String> {
    seed_tree(&workspace.root, &case["initialFiles"])?;

    let change_sets = case
        .get("changeSets")
        .and_then(Value::as_array)
        .ok_or_else(|| "    用例缺少 changeSets 数组".to_string())?;
    for change_set in change_sets {
        seed_change_set(workspace, change_set)?;
    }

    let revert = &case["revert"];
    let change_ids: Vec<String> = revert
        .get("changeSetIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "    revert 缺少 changeSetIds 数组".to_string())?
        .iter()
        .map(|value| value.as_str().unwrap_or_default().to_string())
        .collect();
    let result = revert_change_sets_blocking(
        &workspace.journal,
        &change_ids,
        flag_field(revert, "dryRun"),
        &workspace.root,
    )
    .map_err(|err| format!("    批量回滚整条失败了: {err}"))?;

    let expected = &case["expected"];
    let actual = serde_json::to_value(&result).map_err(|err| format!("    序列化回执失败: {err}"))?;
    compare("回执", &actual, &expected["result"])?;
    compare("回滚后的文件树", &read_tree(&workspace.root)?, &expected["files"])?;

    let entries = expected
        .get("entries")
        .and_then(Value::as_object)
        .ok_or_else(|| "    expected 缺少 entries 对象".to_string())?;
    for (change_id, status) in entries {
        compare(
            &format!("条目 {change_id} 的 status"),
            &read_entry_status(&workspace.journal, change_id),
            status,
        )?;
    }
    Ok(())
}

/// 登记一条账并把它推到 fixture 要求的初始状态。
///
/// `reverted` 只能直接改条目里的状态位——真跑一次回滚会顺带改动磁盘，那就不是「初始条件」了。
fn seed_change_set(workspace: &ParityWorkspace, change_set: &Value) -> Result<(), String> {
    let change_id = text_field(change_set, "id")?;
    let files = change_set
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("    账 {change_id} 缺少 files 数组"))?
        .iter()
        .map(|file| {
            Ok(ChangeFileInput {
                path: text_field(file, "path")?.to_string(),
                before: optional_text(&file["before"])?,
                after: optional_text(&file["after"])?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    prepare_change_set(
        &workspace.journal,
        WorkspaceChangeContext {
            change_id: change_id.to_string(),
            session_id: "session".to_string(),
            run_id: "run".to_string(),
            tool_call_id: "call".to_string(),
        },
        &workspace.root,
        files,
    )
    .map_err(|err| format!("    登记账 {change_id} 失败: {err}"))?;

    match text_field(change_set, "status")? {
        "prepared" => Ok(()),
        "applied" => mark_change_applied(&workspace.journal, change_id)
            .map_err(|err| format!("    标记账 {change_id} 为 applied 失败: {err}")),
        "reverted" => {
            let mut entry = read_entry(&workspace.journal, change_id)
                .map_err(|err| format!("    读回账 {change_id} 失败: {err}"))?;
            entry.status = ChangeStatus::Reverted;
            write_entry(&workspace.journal, &entry)
                .map_err(|err| format!("    改写账 {change_id} 的状态失败: {err}"))
        }
        other => Err(format!("    账 {change_id} 的 status `{other}` 不认识")),
    }
}
