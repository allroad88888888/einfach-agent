//! 对拍驱动器：整条补丁流水线（带 IO）。
//!
//! 喂 `packages/host-node/fixtures/patch-pipeline.json`，对面是 TS 的
//! `packages/host-node/src/parity/patchPipeline.parity.test.ts`。
//!
//! 断言三段，缺一不可：
//!   1. 回执 JSON 逐字段相同（键顺序不算差异、键的有无算差异，口径见 parity_fixtures.rs）。
//!   2. 落盘后的**整棵树**逐字节相同——多一个文件或少一个文件都算失败。
//!   3. 可选的执行位与日志条目状态。执行位在非 unix 上跳过：`apply_executable_bit` 在那里本来
//!      就是 no-op，两边都什么都不做，比它没有意义。

use super::apply_workspace_patch_blocking_with_journal;
use crate::parity_fixtures::{compare, flag_field, run_cases};
use crate::parity_workspace::{read_entry_status, read_tree, seed_tree, ParityWorkspace};
use crate::workspace_change_journal::WorkspaceChangeContext;
use serde_json::Value;

#[test]
fn patch_pipeline_matches_the_shared_fixture() {
    run_cases("patch-pipeline.json", |case| {
        if flag_field(case, "unixOnly") && !cfg!(unix) {
            return Ok(());
        }
        let workspace = ParityWorkspace::create();
        let outcome = run_case(case, &workspace);
        workspace.cleanup();
        outcome
    });
}

fn run_case(case: &Value, workspace: &ParityWorkspace) -> Result<(), String> {
    seed_tree(&workspace.root, &case["initialFiles"])?;

    let operations = serde_json::from_value(case["operations"].clone())
        .map_err(|err| format!("    operations 收窄失败: {err}"))?;
    let journal = match case.get("changeContext") {
        None | Some(Value::Null) => None,
        Some(raw) => {
            let context: WorkspaceChangeContext = serde_json::from_value(raw.clone())
                .map_err(|err| format!("    changeContext 收窄失败: {err}"))?;
            Some((workspace.journal.clone(), context))
        }
    };

    let result = apply_workspace_patch_blocking_with_journal(
        operations,
        flag_field(case, "dryRun"),
        Some(workspace.root.to_string_lossy().into_owned()),
        journal,
        "workspace-patch-parity".to_string(),
    )
    .map_err(|err| format!("    流水线整条失败了: {err}"))?;

    let expected = &case["expected"];
    let actual = serde_json::to_value(&result).map_err(|err| format!("    序列化回执失败: {err}"))?;
    compare("回执", &actual, &expected["result"])?;
    compare("落盘后的文件树", &read_tree(&workspace.root)?, &expected["files"])?;
    compare_executable_bits(workspace, &expected["executable"])?;

    if let Some(entries) = expected.get("journalEntries").and_then(Value::as_object) {
        for (change_id, status) in entries {
            compare(
                &format!("条目 {change_id} 的 status"),
                &read_entry_status(&workspace.journal, change_id),
                status,
            )?;
        }
    }
    Ok(())
}

/// 只比「有没有执行位」，不比完整 mode：新建文件的基准权限跟 umask 走，两次运行都可能不同。
#[cfg(unix)]
fn compare_executable_bits(workspace: &ParityWorkspace, expected: &Value) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let Some(entries) = expected.as_object() else {
        return Ok(());
    };
    for (relative_path, flag) in entries {
        let path = workspace.root.join(relative_path);
        let metadata =
            std::fs::metadata(&path).map_err(|err| format!("    stat {path:?} 失败: {err}"))?;
        let executable = metadata.permissions().mode() & 0o111 != 0;
        compare(
            &format!("{relative_path} 的执行位"),
            &Value::Bool(executable),
            flag,
        )?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn compare_executable_bits(_workspace: &ParityWorkspace, _expected: &Value) -> Result<(), String> {
    Ok(())
}
