mod server_sidecar;

use server_sidecar::RunningServer;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Default)]
struct ManagedServer(Mutex<Option<RunningServer>>);

impl ManagedServer {
    fn store(&self, server: RunningServer) {
        *self.0.lock().expect("managed server mutex poisoned") = Some(server);
    }

    fn stop(&self) {
        if let Some(server) = self.0.lock().expect("managed server mutex poisoned").take() {
            server.stop();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ManagedServer::default())
        .setup(|app| {
            let server = tauri::async_runtime::block_on(server_sidecar::start(app.handle()))?;
            server.handoff_after(
                |ready| {
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(ready.url.clone()))
                        .title("Einfach Agent")
                        .inner_size(1100.0, 760.0)
                        .min_inner_size(720.0, 520.0)
                        .build()
                },
                |server| app.state::<ManagedServer>().store(server),
            )?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Einfach Agent desktop shell");

    app.run(|handle, event| {
        let should_stop = matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. })
            || matches!(
                event,
                RunEvent::WindowEvent {
                    event: WindowEvent::CloseRequested { .. },
                    ..
                }
            );
        if should_stop {
            handle.state::<ManagedServer>().stop();
        }
    });
}
