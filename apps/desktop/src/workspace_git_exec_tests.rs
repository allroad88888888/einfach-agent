use super::*;
use std::path::Path;

// P1/P2：共享 git_command 的 env 兜底——GIT_LITERAL_PATHSPECS=1 + 清空 GIT_EXTERNAL_DIFF。
#[test]
fn git_command_hardens_env() {
    let command = git_command(Path::new("."));
    let envs: Vec<(String, Option<String>)> = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();

    let literal = envs.iter().find(|(key, _)| key == "GIT_LITERAL_PATHSPECS");
    assert_eq!(
        literal.map(|(_, value)| value.clone()),
        Some(Some("1".to_string())),
        "GIT_LITERAL_PATHSPECS must be set to 1"
    );

    let external = envs.iter().find(|(key, _)| key == "GIT_EXTERNAL_DIFF");
    assert_eq!(
        external.map(|(_, value)| value.clone()),
        Some(Some(String::new())),
        "GIT_EXTERNAL_DIFF must be cleared to empty"
    );
}
