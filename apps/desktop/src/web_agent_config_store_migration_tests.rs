use super::WebAgentConfigStore;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static TEST_HOME_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestHome(PathBuf);

impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn test_home() -> TestHome {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEST_HOME_COUNTER.fetch_add(1, Ordering::Relaxed);
    TestHome(std::env::temp_dir().join(format!(
        "web-agent-config-migration-test-{}-{nanos}-{sequence}",
        std::process::id(),
    )))
}

fn write_config(path: &PathBuf, contents: &str) {
    fs::create_dir_all(path.parent().expect("config parent")).expect("create config directory");
    fs::write(path, contents).expect("write config");
}

#[test]
fn migrates_a_legacy_config_to_the_new_default_path_without_deleting_it() {
    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let new_path = home.0.join(".webAgent/config.json");
    let contents = r#"{"version":1,"modelCredentials":{"deepseek:default":"old-key"}}"#;
    write_config(&legacy_path, contents);

    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(
        store.read_section("modelCredentials"),
        Ok(Some(json!({ "deepseek:default": "old-key" })))
    );
    assert_eq!(
        fs::read_to_string(&new_path).expect("read new config"),
        contents
    );
    assert_eq!(
        fs::read_to_string(legacy_path).expect("read legacy config"),
        contents
    );
}

#[test]
fn prefers_an_existing_new_default_config_over_the_legacy_config() {
    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let new_path = home.0.join(".webAgent/config.json");
    write_config(
        &legacy_path,
        r#"{"version":1,"mcp":{"servers":["legacy"]}}"#,
    );
    write_config(&new_path, r#"{"version":1,"mcp":{"servers":["new"]}}"#);

    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(
        store.read_section("mcp"),
        Ok(Some(json!({ "servers": ["new"] })))
    );
    assert_eq!(
        fs::read_to_string(legacy_path).expect("read legacy config"),
        r#"{"version":1,"mcp":{"servers":["legacy"]}}"#
    );
}

#[test]
fn an_override_does_not_read_or_migrate_the_legacy_config() {
    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let override_directory = home.0.join("override");
    write_config(&legacy_path, "not valid json");

    let store = WebAgentConfigStore::from_home_directory_with_config_directory(
        home.0.clone(),
        Some(override_directory.clone().into_os_string()),
    )
    .expect("create overridden store");
    assert_eq!(store.read_section("mcp"), Ok(None));
    assert!(!override_directory.join("config.json").exists());
    assert_eq!(
        fs::read_to_string(legacy_path).expect("read legacy config"),
        "not valid json"
    );
}

#[test]
fn rejects_a_legacy_config_that_cannot_be_parsed_without_creating_the_new_file() {
    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let new_path = home.0.join(".webAgent/config.json");
    write_config(&legacy_path, "not valid json");

    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(
        store.read_section("mcp"),
        Err("旧模型配置文件格式无效".to_string())
    );
    assert!(!new_path.exists());
}

#[test]
fn rejects_an_unreadable_legacy_config_without_creating_the_new_file() {
    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let new_path = home.0.join(".webAgent/config.json");
    fs::create_dir_all(&legacy_path).expect("create legacy directory in place of config");

    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(
        store.read_section("mcp"),
        Err("无法读取旧模型配置文件".to_string())
    );
    assert!(!new_path.exists());
}

#[cfg(unix)]
#[test]
fn migration_restricts_the_new_directory_and_file_to_the_current_user() {
    use std::os::unix::fs::PermissionsExt;

    let home = test_home();
    let legacy_path = home.0.join(".web-agent/config.json");
    let new_directory = home.0.join(".webAgent");
    write_config(&legacy_path, r#"{"version":1,"mcp":{"servers":[]}}"#);

    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    store.read_section("mcp").expect("migrate config");

    let directory = fs::metadata(&new_directory).expect("read directory metadata");
    assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    let file = fs::metadata(new_directory.join("config.json")).expect("read file metadata");
    assert_eq!(file.permissions().mode() & 0o777, 0o600);
}
