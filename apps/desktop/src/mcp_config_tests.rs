use super::McpConfigStore;
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    thread,
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
        "web-agent-mcp-config-test-{}-{nanos}-{sequence}",
        std::process::id(),
    )))
}

fn write_fixture(home: &TestHome, contents: &str) {
    let directory = home.0.join(".web-agent");
    fs::create_dir_all(&directory).expect("create config directory");
    fs::write(directory.join("config.json"), contents).expect("write config fixture");
}

fn stored_config(home: &TestHome) -> Value {
    serde_json::from_str(
        &fs::read_to_string(home.0.join(".web-agent/config.json")).expect("read config"),
    )
    .expect("parse config")
}

#[test]
fn reads_an_empty_object_when_the_config_file_is_missing() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    assert_eq!(store.read(), Ok(json!({})));
}

#[test]
fn reads_an_empty_object_when_the_mcp_section_is_absent() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, r#"{"version":1,"otherSetting":{"enabled":true}}"#);

    assert_eq!(store.read(), Ok(json!({})));
}

#[test]
fn merges_a_patch_into_an_existing_section_and_keeps_other_top_level_keys() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    write_fixture(
        &home,
        r#"{"version":1,"mcp":{"local":{"status":"connected"}},"modelCredentials":{"deepseek:default":"key"}}"#,
    );

    let merged = store
        .merge(json!({ "remote": { "status": "connecting" } }))
        .expect("merge patch");

    assert_eq!(
        merged,
        json!({
            "local": { "status": "connected" },
            "remote": { "status": "connecting" },
        })
    );
    let config = stored_config(&home);
    assert_eq!(config["version"], 1);
    assert_eq!(config["modelCredentials"]["deepseek:default"], "key");
    assert_eq!(config["mcp"], merged);
    assert_eq!(store.read(), Ok(merged));
}

#[test]
fn removes_a_key_when_the_patch_value_is_null() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    write_fixture(
        &home,
        r#"{"version":1,"mcp":{"local":{"status":"connected"},"remote":{"status":"connecting"}}}"#,
    );

    let merged = store
        .merge(json!({ "remote": null }))
        .expect("merge removal patch");

    assert_eq!(merged, json!({ "local": { "status": "connected" } }));
    assert_eq!(store.read(), Ok(merged));
}

#[test]
fn creates_the_section_from_an_empty_config_file() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());

    let merged = store
        .merge(json!({ "local": { "status": "connected" } }))
        .expect("merge into a missing config file");

    assert_eq!(merged, json!({ "local": { "status": "connected" } }));
    assert_eq!(stored_config(&home)["mcp"], merged);
}

#[test]
fn rejects_a_non_object_patch() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());

    assert_eq!(
        store.merge(json!(["not", "an", "object"])),
        Err("mcp 配置段补丁必须是 JSON 对象".to_string())
    );
}

#[test]
fn rejects_a_non_object_existing_section() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, r#"{"version":1,"mcp":"oops"}"#);

    assert_eq!(
        store.merge(json!({ "local": {} })),
        Err("mcp 配置段格式无效".to_string())
    );
}

#[test]
fn rejects_a_corrupted_config_file_on_read_and_write() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());
    write_fixture(&home, "{ not json");

    assert_eq!(store.read(), Err("模型配置文件格式无效".to_string()));
    assert_eq!(
        store.merge(json!({ "local": {} })),
        Err("模型配置文件格式无效".to_string())
    );
    assert_eq!(
        fs::read_to_string(home.0.join(".web-agent/config.json")).expect("read config"),
        "{ not json"
    );
}

#[test]
fn concurrent_merges_from_multiple_threads_do_not_lose_keys() {
    let home = test_home();
    let store = McpConfigStore::from_home_directory(home.0.clone());

    const WRITER_COUNT: usize = 8;
    let handles: Vec<_> = (0..WRITER_COUNT)
        .map(|index| {
            let store = store.clone();
            thread::spawn(move || {
                let mut patch = Map::new();
                patch.insert(
                    format!("server-{index}"),
                    json!({ "status": "connected" }),
                );
                store
                    .merge(Value::Object(patch))
                    .expect("concurrent merge")
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("writer thread panicked");
    }

    let section = store.read().expect("read merged section");
    let servers = section.as_object().expect("section is an object");
    assert_eq!(servers.len(), WRITER_COUNT);
    for index in 0..WRITER_COUNT {
        assert_eq!(
            servers.get(&format!("server-{index}")),
            Some(&json!({ "status": "connected" }))
        );
    }
}
