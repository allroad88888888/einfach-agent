mod shell;
mod workspace_common;
mod workspace_git;
mod workspace_patch;
mod workspace_read;
mod workspace_rg;
mod workspace_task;
mod workspace_write;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      shell::run_shell_command,
      workspace_read::read_workspace_file,
      workspace_read::read_workspace_run_index_page,
      workspace_read::list_workspace_files,
      workspace_read::search_workspace_files,
      workspace_rg::rg_search_workspace,
      workspace_task::run_workspace_task,
      workspace_patch::apply_workspace_patch,
      workspace_write::write_workspace_file,
      workspace_git::get_workspace_diff,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
