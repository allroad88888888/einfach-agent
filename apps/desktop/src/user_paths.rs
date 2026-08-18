use tauri::{AppHandle, Manager};

/**
 * `packages/agent-core/src/runtime/userSkillsRoot.ts` 需要用户主目录来定位
 * `~/.webAgent/skills` 与 `~/.claude/skills` 这两个项目 Skills 扫描根，之前是靠 core
 * 直接 `import('@tauri-apps/api/path').homeDir` 拿到的——那是 core 里第二条绕过命令桥、
 * 直连 `@tauri-apps` 运行时的边。这个命令把它收口进既有的「host 经命令桥调用 Rust」通路，
 * 使 core 只需要 `invoke('get_user_home_dir')`，浏览器/HTTP/Node 三种宿主也能各自注入
 * 自己的实现（详见 issue H4d 系列）。
 *
 * 归一化（去尾斜杠等）**不在这里做**：不同平台/版本上 `home_dir()` 带不带尾斜杠不一致，
 * 但这属于纯逻辑，留在 core 一份（`stripTrailingSlash`），三个宿主共用同一份归一，不在
 * Rust/HTTP/Node 里各刻一份、各错一份。这里原样把 `home_dir()` 给的路径转成字符串返回。
 */
#[tauri::command]
pub fn get_user_home_dir(app: AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "无法定位用户主目录".to_string())?;
    home.into_os_string()
        .into_string()
        .map_err(|_| "用户主目录路径包含无法解析的非 UTF-8 字符".to_string())
}
