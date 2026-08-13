//! workspace 读取命令的模块装配与 Tauri 命令入口。

#[path = "workspace_read_bytes.rs"]
mod bytes;
#[path = "workspace_read_content.rs"]
mod content;
#[path = "workspace_read_limits.rs"]
mod limits;
#[path = "workspace_read_lines.rs"]
mod lines;
#[path = "workspace_read_list.rs"]
mod list;
#[path = "workspace_read_paths.rs"]
mod paths;
#[path = "workspace_read_run_index.rs"]
mod run_index;
#[path = "workspace_read_search.rs"]
mod search;
#[path = "workspace_read_types.rs"]
mod types;
#[path = "workspace_read_walk.rs"]
mod walk;

#[cfg(test)]
#[path = "workspace_read_test_support.rs"]
mod test_support;

use self::bytes::read_workspace_file_blocking_with_access_at;
use self::lines::read_workspace_file_lines;
use self::list::list_workspace_files_blocking_with_access;
use self::run_index::read_workspace_run_index_page_blocking;
use self::search::search_workspace_files_blocking_with_access;
use self::types::{
    ListWorkspaceFilesResult, ReadWorkspaceFileResult, ReadWorkspaceRunIndexPageResult,
    SearchWorkspaceFilesResult,
};

#[tauri::command(rename_all = "snake_case")]
pub async fn read_workspace_file(
    path: String,
    max_bytes: Option<usize>,
    offset: Option<u64>,
    start_line: Option<usize>,
    line_count: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<ReadWorkspaceFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_file_blocking_at_lines(
            path,
            max_bytes,
            offset,
            start_line,
            line_count,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("read_workspace_file worker failed: {err}"))?
}

/// 从 runs.jsonl 文件尾向前稳定分页。cursor 绑定完整文件内容 fingerprint；append、压缩或
/// 替换发生后旧 cursor 会显式失效，前端不能把两个索引版本静默拼接。
#[tauri::command(rename_all = "snake_case")]
pub async fn read_workspace_run_index_page(
    cursor: Option<String>,
    max_records: Option<usize>,
    workspace_root: Option<String>,
) -> Result<ReadWorkspaceRunIndexPageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_run_index_page_blocking(cursor, max_records, workspace_root)
    })
    .await
    .map_err(|err| format!("read_workspace_run_index_page worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_workspace_files(
    path: Option<String>,
    recursive: Option<bool>,
    max_entries: Option<usize>,
    include_hidden: Option<bool>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<ListWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_files_blocking_with_access(
            path,
            recursive,
            max_entries,
            include_hidden,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("list_workspace_files worker failed: {err}"))?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn search_workspace_files(
    query: String,
    path: Option<String>,
    glob: Option<String>,
    max_matches: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: Option<bool>,
) -> Result<SearchWorkspaceFilesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_files_blocking_with_access(
            query,
            path,
            glob,
            max_matches,
            workspace_root,
            allow_external_paths.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| format!("search_workspace_files worker failed: {err}"))?
}

#[allow(clippy::too_many_arguments)]
fn read_workspace_file_blocking_at_lines(
    path: String,
    max_bytes: Option<usize>,
    offset: Option<u64>,
    start_line: Option<usize>,
    line_count: Option<usize>,
    workspace_root: Option<String>,
    allow_external_paths: bool,
) -> Result<ReadWorkspaceFileResult, String> {
    if start_line.is_none() && line_count.is_none() {
        return read_workspace_file_blocking_with_access_at(
            path,
            max_bytes,
            offset,
            workspace_root,
            allow_external_paths,
        );
    }
    // 两种定位方式互斥：同时给会让「续读」产生两个互相矛盾的游标。
    if offset.is_some_and(|value| value > 0) {
        return Err(
            "pass either offset or startLine, not both; use nextLine to continue a line read"
                .to_string(),
        );
    }
    read_workspace_file_lines(
        path,
        max_bytes,
        start_line.unwrap_or(1),
        line_count,
        workspace_root,
        allow_external_paths,
    )
}
