use super::*;

// P1：diff/stat 参数三件套——`-c diff.external=` 在 `diff` 之前，且带 `--no-ext-diff` / `--no-textconv`。
#[test]
fn diff_args_disable_external_diff_and_textconv() {
    for (staged, stat) in [(false, false), (true, false), (false, true), (true, true)] {
        let args = diff_args(staged, None, stat, &[]);
        let external_idx = args
            .iter()
            .position(|arg| arg == "diff.external=")
            .expect("diff.external= present");
        let diff_idx = args
            .iter()
            .position(|arg| arg == "diff")
            .expect("diff subcommand present");
        // `-c diff.external=` 必须作为全局选项排在子命令 `diff` 之前。
        assert!(
            external_idx < diff_idx,
            "-c diff.external= must precede diff"
        );
        assert_eq!(args.get(external_idx - 1).map(String::as_str), Some("-c"));
        assert!(args.iter().any(|arg| arg == "--no-ext-diff"));
        assert!(args.iter().any(|arg| arg == "--no-textconv"));
    }
}

// P1：--no-ext-diff / --no-textconv 是 diff 专属选项，status 不该带（带了会报错）；
// status 的外部命令兜底靠 git_command 的 env，参数层保持干净。
#[test]
fn status_args_have_no_diff_only_flags() {
    let args = status_args(&[]);
    assert!(!args.iter().any(|arg| arg == "--no-ext-diff"));
    assert!(!args.iter().any(|arg| arg == "--no-textconv"));
    assert!(!args.iter().any(|arg| arg == "diff.external="));
}
