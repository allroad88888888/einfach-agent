mod mcp;
mod shell;
mod workspace_change_journal;
mod workspace_common;
mod workspace_delete;
mod workspace_git;
mod workspace_patch;
mod workspace_path_ops;
mod workspace_read;
mod workspace_rg;
mod workspace_task;
mod workspace_write;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(mcp::McpManager::default())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .max_file_size(5 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            mcp::mcp_connect,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            mcp::mcp_disconnect,
            shell::run_shell_command,
            workspace_read::read_workspace_file,
            workspace_read::read_workspace_run_index_page,
            workspace_read::list_workspace_files,
            workspace_read::search_workspace_files,
            workspace_rg::rg_search_workspace,
            workspace_task::run_workspace_task,
            workspace_patch::apply_workspace_patch,
            workspace_change_journal::revert_workspace_change,
            workspace_delete::delete_workspace_path,
            workspace_path_ops::copy_workspace_path,
            workspace_path_ops::move_workspace_path,
            workspace_write::write_workspace_file,
            workspace_git::get_workspace_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
