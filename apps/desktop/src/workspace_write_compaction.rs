//! 子 Agent 归档索引的自动压缩：按大小与节流窗口把 JSONL 收敛成每个键的最新记录。

use super::limits::{INDEX_COMPACT_MAX_BYTES, INDEX_COMPACT_MIN_BYTES, INDEX_COMPACT_THROTTLE};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn maybe_compact_subagent_index(path: &Path) -> Result<(), String> {
    let Some(name) = subagent_index_name(path) else {
        return Ok(());
    };
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "failed to inspect {name} index for compaction: {err}"
            ))
        }
    };
    if metadata.len() < INDEX_COMPACT_MIN_BYTES {
        return Ok(());
    }
    if metadata.len() > INDEX_COMPACT_MAX_BYTES {
        return Err(format!(
            "{name} index exceeds automatic compaction limit of {INDEX_COMPACT_MAX_BYTES} bytes"
        ));
    }

    let marker = path.with_file_name(format!(".{name}.compact-at"));
    if fs::metadata(&marker)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < INDEX_COMPACT_THROTTLE)
    {
        return Ok(());
    }

    let text = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {name} index for compaction: {err}"))?;
    let compacted = compact_subagent_index(name, &text)?;
    atomic_replace(path, compacted.as_bytes(), "compact")?;
    fs::write(&marker, now_millis().to_string())
        .map_err(|err| format!("failed to update {name} compaction marker: {err}"))?;
    Ok(())
}

fn subagent_index_name(path: &Path) -> Option<&'static str> {
    let filename = path.file_name()?.to_str()?;
    let name = match filename {
        "runs.jsonl" => "runs",
        "skills.jsonl" => "skills",
        "agents.jsonl" => "agents",
        _ => return None,
    };
    let parent = path.parent()?;
    if parent.file_name()?.to_str()? != "index"
        || parent.parent()?.file_name()?.to_str()? != ".webAgent-archive"
    {
        return None;
    }
    Some(name)
}

fn compact_subagent_index(name: &str, text: &str) -> Result<String, String> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, (usize, serde_json::Value)> = HashMap::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let record: serde_json::Value = serde_json::from_str(line)
            .map_err(|err| format!("{name} index line {}: invalid JSON ({err})", index + 1))?;
        let object = record
            .as_object()
            .ok_or_else(|| format!("{name} index line {}: record must be an object", index + 1))?;
        let field = |key: &str| {
            object
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let key = if name == "skills" {
            field("skillId")
                .ok_or_else(|| format!("skills index line {}: record requires skillId", index + 1))?
                .to_string()
        } else {
            let conversation = field("conversationId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            let run = field("runId").ok_or_else(|| {
                format!(
                    "{name} index line {}: record requires conversationId and runId",
                    index + 1
                )
            })?;
            if name == "runs" {
                format!("{conversation}\0{run}")
            } else {
                let agent_path = field("path").ok_or_else(|| {
                    format!("agents index line {}: record requires path", index + 1)
                })?;
                format!("{conversation}\0{run}\0{agent_path}")
            }
        };
        latest.insert(key, (index, record));
    }
    let mut records: Vec<_> = latest.into_values().collect();
    records.sort_by_key(|(index, _)| *index);
    let mut output = String::new();
    for (_, record) in records {
        output.push_str(
            &serde_json::to_string(&record)
                .map_err(|err| format!("failed to serialize compacted {name} index: {err}"))?,
        );
        output.push('\n');
    }
    Ok(output)
}

fn atomic_replace(path: &Path, content: &[u8], suffix: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{suffix}-{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    fs::write(&temporary, content)
        .map_err(|err| format!("failed to write temporary index: {err}"))?;
    let result = fs::rename(&temporary, path)
        .map_err(|err| format!("failed to replace compacted index: {err}"));
    let _ = fs::remove_file(temporary);
    result
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_write::test_support::unique_workspace;

    #[test]
    fn automatic_index_compaction_keeps_latest_records_only() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".webAgent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let target = index_root.join("runs.jsonl");
        let filler = "x".repeat(700);
        let mut text = String::new();
        for status in 0..220 {
            text.push_str(
                &serde_json::json!({
                    "conversationId": "conversation",
                    "runId": "run",
                    "status": status,
                    "summary": filler,
                })
                .to_string(),
            );
            text.push('\n');
        }
        assert!(text.len() as u64 > INDEX_COMPACT_MIN_BYTES);
        fs::write(&target, text).expect("write oversized index");

        maybe_compact_subagent_index(&target).expect("compact index");
        let records: Vec<serde_json::Value> = fs::read_to_string(&target)
            .expect("read compacted index")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid record"))
            .collect();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["status"], 219);
        assert!(index_root.join(".runs.compact-at").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn index_compaction_uses_the_documented_keys() {
        let agents = [
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-02", "status": "running"}),
            serde_json::json!({"conversationId": "c", "runId": "r", "path": "root-01", "status": "completed"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_agents = compact_subagent_index("agents", &agents).expect("agents compact");
        let agent_records: Vec<serde_json::Value> = compacted_agents
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid agent record"))
            .collect();
        assert_eq!(agent_records.len(), 2);
        assert_eq!(agent_records[1]["path"], "root-01");
        assert_eq!(agent_records[1]["status"], "completed");

        let skills = [
            serde_json::json!({"skillId": "s1", "summary": "old"}),
            serde_json::json!({"skillId": "s2", "summary": "other"}),
            serde_json::json!({"skillId": "s1", "summary": "new"}),
        ]
        .into_iter()
        .map(|record| record.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        let compacted_skills = compact_subagent_index("skills", &skills).expect("skills compact");
        let skill_records: Vec<serde_json::Value> = compacted_skills
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid skill record"))
            .collect();
        assert_eq!(skill_records.len(), 2);
        assert_eq!(skill_records[1]["skillId"], "s1");
        assert_eq!(skill_records[1]["summary"], "new");
    }

    #[test]
    fn compaction_failure_preserves_index_and_events_are_never_compacted() {
        let (base, ws) = unique_workspace();
        let index_root = ws.join(".webAgent-archive/index");
        fs::create_dir_all(&index_root).expect("create index root");
        let index = index_root.join("skills.jsonl");
        let malformed = format!("{{bad}}\n{}", " ".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&index, &malformed).expect("write malformed index");
        let error = maybe_compact_subagent_index(&index).expect_err("malformed index must fail");
        assert!(error.contains("invalid JSON"));
        assert_eq!(
            fs::read_to_string(&index).expect("read preserved index"),
            malformed
        );

        let events = ws.join(".webAgent-archive/conversations/c/runs/r/events.jsonl");
        fs::create_dir_all(events.parent().expect("events parent")).expect("create events root");
        let event_text = format!("event\n{}", "x".repeat(INDEX_COMPACT_MIN_BYTES as usize));
        fs::write(&events, &event_text).expect("write events");
        maybe_compact_subagent_index(&events).expect("events bypass compaction");
        assert_eq!(fs::read_to_string(events).expect("read events"), event_text);
        let _ = fs::remove_dir_all(&base);
    }
}
