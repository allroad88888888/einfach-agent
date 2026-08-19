//! 对拍驱动器：一个补丁操作作用在暂存状态上的规则。
//!
//! 喂 `packages/host-node/fixtures/patch-stage-rules.json`，对面是 TS 的
//! `packages/host-node/src/parity/patchStageRules.parity.test.ts`。
//!
//! ## 这一侧为什么还是要一个真目录
//!
//! TS 把纯规则（`validatePatchOperationInput` + `nextFileState`）与 IO 分成了两个文件，那半边一行
//! IO 都没有。Rust 这边没有对应的拆分：`stage_operation` 里连着 `resolve_workspace_path`（要一个
//! 存在且已 canonicalize 的 root）和 `load_state`（第一次碰到某路径就读一次磁盘）。所以驱动器建一
//! 个**空目录**做路径解析，并把 fixture 里的初始状态**预置进暂存表**——`load_state` 先查
//! `contains_key`，命中就不读盘了。于是磁盘全程既不被读也不被写，两侧喂的仍是同一组
//! `(state, operation)`。
//!
//! 这也是 fixture schema 里「一个用例只碰一条路径」那条约定的由来：预置的是一格，操作跑到别的
//! 路径上就会去读磁盘、静默拿到 `None`。驱动器逐步断言这一点，不让它静默。

use super::*;
use crate::parity_fixtures::{compare, optional_text, run_cases, text_field};
use crate::parity_workspace::ParityWorkspace;
use serde_json::{json, Value};

#[test]
fn stage_rules_match_the_shared_fixture() {
    // 整组共用一个空 root：路径解析要它存在，除此之外没人碰它。
    let workspace = ParityWorkspace::create();
    run_cases("patch-stage-rules.json", |case| {
        let relative_path = text_field(case, "path")?;
        let absolute = workspace.root.join(relative_path);
        let mut files: HashMap<PathBuf, FileState> = HashMap::new();
        files.insert(absolute.clone(), file_state(&case["initial"])?);

        let steps = case
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| "    用例缺少 steps 数组".to_string())?;
        for (index, step) in steps.iter().enumerate() {
            let raw_operation = &step["operation"];
            let declared = raw_operation
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if declared != relative_path {
                return Err(format!(
                    "    第 {} 步的 path 是 `{declared}`，与用例的 `{relative_path}` 不同——\
                     schema 约定一个用例只碰一条路径",
                    index + 1
                ));
            }
            let operation: PatchOperation = serde_json::from_value(raw_operation.clone())
                .map_err(|err| format!("    第 {} 步的 operation 收窄失败: {err}", index + 1))?;

            let outcome = stage_operation(&workspace.root, &mut files, &operation);
            let expectation = &step["expect"];
            match expectation.get("error").and_then(Value::as_str) {
                Some(expected_error) => {
                    // 被拒的一步不改状态：下一步接着用上一步的 state（两侧实现都是如此）。
                    let actual = outcome.err().unwrap_or_else(|| "<没有被拒>".to_string());
                    compare(
                        &format!("第 {} 步的错误文案", index + 1),
                        &Value::String(actual),
                        &Value::String(expected_error.to_string()),
                    )?;
                }
                None => {
                    outcome.map_err(|reason| {
                        format!("    第 {} 步不该被拒，实际报了 `{reason}`", index + 1)
                    })?;
                    let state = files
                        .get(&absolute)
                        .ok_or_else(|| format!("    第 {} 步之后暂存表里没有这条路径", index + 1))?;
                    compare(
                        &format!("第 {} 步之后的暂存状态", index + 1),
                        &state_json(state),
                        &expectation["state"],
                    )?;
                }
            }
        }
        Ok(())
    });
    workspace.cleanup();
}

/// fixture 里的初始状态 → `FileState`。
fn file_state(value: &Value) -> Result<FileState, String> {
    Ok(FileState {
        initial: optional_text(&value["initial"])?,
        current: optional_text(&value["current"])?,
        executable: match &value["executable"] {
            Value::Null => None,
            Value::Bool(flag) => Some(*flag),
            other => return Err(format!("    executable 期望 bool | null，实际是 {other}")),
        },
    })
}

/// `FileState` 没有 derive Serialize（它是纯内部结构），比对时按 fixture 的键名手写投影。
fn state_json(state: &FileState) -> Value {
    json!({
        "initial": state.initial,
        "current": state.current,
        "executable": state.executable,
    })
}
