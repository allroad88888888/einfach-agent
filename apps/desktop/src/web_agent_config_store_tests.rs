use super::WebAgentConfigStore;
use serde_json::json;
use std::{
    ffi::OsString,
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
        "web-agent-config-store-test-{}-{nanos}-{sequence}",
        std::process::id(),
    )))
}

fn stored_config(config_directory: &PathBuf) -> serde_json::Value {
    serde_json::from_str(
        &fs::read_to_string(config_directory.join("config.json")).expect("read config"),
    )
    .expect("parse config")
}

fn write_fixture(home: &TestHome, contents: &str) {
    let directory = home.0.join(".web-agent");
    fs::create_dir_all(&directory).expect("create config directory");
    fs::write(directory.join("config.json"), contents).expect("write config fixture");
}

#[test]
fn uses_the_hidden_web_agent_config_path_without_an_override() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(store.path, home.0.join(".web-agent/config.json"));
}

#[test]
fn uses_an_absolute_config_directory_override_for_reads_and_writes() {
    let home = test_home();
    let config_directory = home.0.join("separate-config");
    let store = WebAgentConfigStore::from_home_directory_with_config_directory(
        home.0.clone(),
        Some(config_directory.clone().into_os_string()),
    )
    .expect("create store");

    store
        .write_section("mcp", json!({ "servers": ["local"] }))
        .expect("write section");

    assert_eq!(store.path, config_directory.join("config.json"));
    assert_eq!(
        store.read_section("mcp"),
        Ok(Some(json!({ "servers": ["local"] })))
    );
    assert_eq!(
        stored_config(&config_directory)["mcp"]["servers"][0],
        "local"
    );
    assert!(!home.0.join(".web-agent/config.json").exists());
}

#[test]
fn rejects_an_empty_config_directory_override() {
    let home = test_home();
    assert_eq!(
        WebAgentConfigStore::from_home_directory_with_config_directory(
            home.0.clone(),
            Some(OsString::new()),
        )
        .expect_err("reject empty override"),
        "WEB_AGENT_CONFIG_DIR 不能为空"
    );
}

#[test]
fn rejects_a_relative_config_directory_override() {
    let home = test_home();
    assert_eq!(
        WebAgentConfigStore::from_home_directory_with_config_directory(
            home.0.clone(),
            Some(OsString::from("another-profile")),
        )
        .expect_err("reject relative override"),
        "WEB_AGENT_CONFIG_DIR 必须是绝对路径"
    );
}

#[test]
fn rejects_an_existing_file_as_a_config_directory_override() {
    let home = test_home();
    let config_directory = home.0.join("config-file");
    fs::create_dir_all(&home.0).expect("create home directory");
    fs::write(&config_directory, "not a directory").expect("create config file");

    assert_eq!(
        WebAgentConfigStore::from_home_directory_with_config_directory(
            home.0.clone(),
            Some(config_directory.into_os_string()),
        )
        .expect_err("reject a config file"),
        "WEB_AGENT_CONFIG_DIR 必须是目录"
    );
}

#[cfg(unix)]
#[test]
fn rejects_an_existing_non_private_config_directory_without_changing_its_mode() {
    use std::os::unix::fs::PermissionsExt;

    let home = test_home();
    let config_directory = home.0.join("shared-config");
    fs::create_dir_all(&config_directory).expect("create config directory");
    fs::set_permissions(&config_directory, fs::Permissions::from_mode(0o755))
        .expect("set shared permissions");

    assert_eq!(
        WebAgentConfigStore::from_home_directory_with_config_directory(
            home.0.clone(),
            Some(config_directory.clone().into_os_string()),
        )
        .expect_err("reject non-private directory"),
        "WEB_AGENT_CONFIG_DIR 目录权限必须为 0700"
    );
    assert_eq!(
        fs::metadata(config_directory)
            .expect("read directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[test]
fn reads_a_missing_section_as_none() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    assert_eq!(store.read_section("mcp"), Ok(None));

    write_fixture(&home, r#"{"version":1,"otherSetting":{"enabled":true}}"#);
    assert_eq!(store.read_section("mcp"), Ok(None));
}

#[test]
fn writing_a_section_keeps_other_top_level_keys() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    write_fixture(
        &home,
        r#"{"version":1,"modelCredentials":{"deepseek:default":"test-key"},"otherSetting":{"enabled":true}}"#,
    );

    store
        .write_section("mcp", json!({ "servers": ["local"] }))
        .expect("write section");

    let config = stored_config(&home.0.join(".web-agent"));
    assert_eq!(config["version"], 1);
    assert_eq!(config["mcp"]["servers"][0], "local");
    assert_eq!(config["modelCredentials"]["deepseek:default"], "test-key");
    assert_eq!(config["otherSetting"]["enabled"], true);
    assert_eq!(
        store.read_section("mcp"),
        Ok(Some(json!({ "servers": ["local"] })))
    );
}

#[test]
fn updating_a_section_sees_the_current_value_and_can_remove_it() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, r#"{"version":1,"mcp":{"servers":[]}}"#);

    store
        .update_section("mcp", |current| {
            assert_eq!(current, Some(json!({ "servers": [] })));
            Ok(Some(json!({ "servers": ["local"] })))
        })
        .expect("update section");
    assert_eq!(
        stored_config(&home.0.join(".web-agent"))["mcp"]["servers"][0],
        "local"
    );

    store.remove_section("mcp").expect("remove section");
    assert_eq!(store.read_section("mcp"), Ok(None));
    assert_eq!(stored_config(&home.0.join(".web-agent"))["version"], 1);
}

#[test]
fn keeps_the_file_untouched_when_an_update_fails() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, r#"{"version":1,"mcp":{"servers":[]}}"#);

    assert_eq!(
        store.update_section("mcp", |_| Err("拒绝写入".to_string())),
        Err("拒绝写入".to_string())
    );
    assert_eq!(
        stored_config(&home.0.join(".web-agent"))["mcp"],
        json!({ "servers": [] })
    );
}

#[test]
fn rejects_a_corrupted_config_file() {
    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, "{ not json");

    assert_eq!(
        store.read_section("mcp"),
        Err("模型配置文件格式无效".to_string())
    );
    assert_eq!(
        store.write_section("mcp", json!({})),
        Err("模型配置文件格式无效".to_string())
    );
    assert_eq!(
        fs::read_to_string(home.0.join(".web-agent/config.json")).expect("read config"),
        "{ not json"
    );
}

#[cfg(unix)]
#[test]
fn restricts_the_config_directory_and_file_to_the_current_user() {
    use std::os::unix::fs::PermissionsExt;

    let home = test_home();
    let store = WebAgentConfigStore::from_home_directory(home.0.clone());
    store
        .write_section("mcp", json!({ "servers": [] }))
        .expect("write section");

    let directory = fs::metadata(home.0.join(".web-agent")).expect("read directory metadata");
    assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    let file = fs::metadata(home.0.join(".web-agent/config.json")).expect("read metadata");
    assert_eq!(file.permissions().mode() & 0o777, 0o600);
}

#[cfg(unix)]
#[test]
fn restricts_an_overridden_config_directory_and_file_to_the_current_user() {
    use std::os::unix::fs::PermissionsExt;

    let home = test_home();
    let config_directory = home.0.join("separate-config");
    let store = WebAgentConfigStore::from_home_directory_with_config_directory(
        home.0.clone(),
        Some(config_directory.clone().into_os_string()),
    )
    .expect("create store");
    store
        .write_section("mcp", json!({ "servers": [] }))
        .expect("write section");

    let directory = fs::metadata(&config_directory).expect("read directory metadata");
    assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    let file = fs::metadata(config_directory.join("config.json")).expect("read metadata");
    assert_eq!(file.permissions().mode() & 0o777, 0o600);
}
