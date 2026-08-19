mod mcp;
mod mcp_config;
mod model_credential_config;
mod model_credentials;
mod model_provider;
mod model_provider_route;
mod model_proxy;
mod model_proxy_body;
mod model_proxy_envelope;
mod model_proxy_http;
mod model_request_registry;
mod shell;
mod user_paths;
mod web_agent_config_store;
mod web_agent_config_write;
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

// Rust ↔ TS 对拍的共用支撑。fixture 是 packages/host-node/fixtures/ 下的语言无关 JSON，
// 各组的驱动器挂在它需要的那个模块里（`*_parity_tests.rs`），说明见那个目录的 README.md。
#[cfg(test)]
mod parity_fixtures;
#[cfg(test)]
mod parity_workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(mcp::McpManager::default())
        .manage(model_request_registry::ModelRequestCanceller::default())
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
            mcp_config::mcp_config_read,
            mcp_config::mcp_config_write,
            model_credentials::model_credential_status,
            model_credentials::model_credential_set,
            model_credentials::model_credential_delete,
            model_proxy::model_provider_request,
            model_proxy::cancel_model_provider_request,
            model_proxy::model_chat_completions,
            model_proxy::cancel_model_chat_completions,
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
            user_paths::get_user_home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
