//! 对拍驱动器：改动摘要（纯函数）。
//!
//! 喂 `packages/host-node/fixtures/change-summary.json`，对面是 TS 的
//! `packages/host-node/src/parity/changeSummary.parity.test.ts`。
//!
//! 这一组在 Rust 侧原本**零测试**——`compute_change_summary` 住在 workspace_common.rs 里，那个
//! 文件此前没有 `mod tests`。所以本组既是对拍，也是它在 Rust 侧的第一份测试。

use super::compute_change_summary;
use crate::parity_fixtures::{compare, run_cases, text_field};

#[test]
fn change_summary_matches_the_shared_fixture() {
    run_cases("change-summary.json", |case| {
        // `before` 是 `string | null`，`null` = 这个文件是新建的（Rust 侧就是 `None`）。
        let before = case.get("before").and_then(|value| value.as_str());
        let after = text_field(case, "after")?;
        let summary = compute_change_summary(before, after);
        let actual = serde_json::to_value(&summary)
            .map_err(|err| format!("    序列化摘要失败: {err}"))?;
        compare("changeSummary", &actual, &case["expected"])
    });
}
