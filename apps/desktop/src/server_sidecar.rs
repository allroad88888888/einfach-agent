use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use thiserror::Error;
use url::{Host, Url};

const READY_KIND: &str = "einfach-agent-server-ready";
const READY_VERSION: u8 = 1;
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_READY_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub struct ReadyServer {
    pub url: Url,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SidecarError {
    #[error("server ready frame is invalid")]
    InvalidReadyFrame,
    #[error("server ready frame timed out")]
    ReadyTimeout,
    #[error("server exited before it was ready")]
    ExitedBeforeReady,
    #[error("bundled server resource is unavailable")]
    MissingServerResource,
    #[error("bundled Node sidecar could not be started")]
    SpawnFailed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyFrame {
    kind: String,
    version: u8,
    url: String,
}

pub fn parse_ready_server_line(line: &str) -> Result<ReadyServer, SidecarError> {
    let frame: ReadyFrame =
        serde_json::from_str(line).map_err(|_| SidecarError::InvalidReadyFrame)?;
    if frame.kind != READY_KIND || frame.version != READY_VERSION {
        return Err(SidecarError::InvalidReadyFrame);
    }
    let url = Url::parse(&frame.url).map_err(|_| SidecarError::InvalidReadyFrame)?;
    let loopback = matches!(url.host(), Some(Host::Ipv4(address)) if address.is_loopback())
        || matches!(url.host(), Some(Host::Ipv6(address)) if address.is_loopback())
        || matches!(url.host(), Some(Host::Domain("localhost")));
    if url.scheme() != "http" || !loopback {
        return Err(SidecarError::InvalidReadyFrame);
    }
    Ok(ReadyServer { url })
}

struct ChildGuard(Option<CommandChild>);

impl ChildGuard {
    fn new(child: CommandChild) -> Self {
        Self(Some(child))
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            let _ = child.kill();
        }
    }
}

pub(crate) struct RunningServer {
    pub ready: ReadyServer,
    _child: ChildGuard,
}

impl RunningServer {
    pub(crate) fn handoff_after<T, E>(
        self,
        create: impl FnOnce(&ReadyServer) -> Result<T, E>,
        handoff: impl FnOnce(Self),
    ) -> Result<T, E> {
        let created = create(&self.ready)?;
        handoff(self);
        Ok(created)
    }

    pub fn stop(self) {
        drop(self);
    }
}

pub(crate) async fn start(app: &AppHandle) -> Result<RunningServer, SidecarError> {
    let script = app
        .path()
        .resource_dir()
        .map_err(|_| SidecarError::MissingServerResource)?
        .join("server/main.js");
    if !script.is_file() {
        return Err(SidecarError::MissingServerResource);
    }

    let command = app
        .shell()
        .sidecar("einfach-agent-node")
        .map_err(|_| SidecarError::SpawnFailed)?
        .args([
            script.into_os_string(),
            "--ready-json".into(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            "0".into(),
        ]);
    let (mut events, child) = command.spawn().map_err(|_| SidecarError::SpawnFailed)?;
    await_ready_with_child(&mut events, child, READY_TIMEOUT).await
}

async fn await_ready_with_child(
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
    child: CommandChild,
    timeout: Duration,
) -> Result<RunningServer, SidecarError> {
    let child = ChildGuard::new(child);
    let ready = read_ready_event_with_timeout(events, timeout).await?;
    Ok(RunningServer {
        ready,
        _child: child,
    })
}

async fn read_ready_event_with_timeout(
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
    timeout: Duration,
) -> Result<ReadyServer, SidecarError> {
    tokio::time::timeout(timeout, read_ready_event_inner(events))
        .await
        .map_err(|_| SidecarError::ReadyTimeout)?
}

async fn read_ready_event_inner(
    events: &mut tauri::async_runtime::Receiver<CommandEvent>,
) -> Result<ReadyServer, SidecarError> {
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                if bytes.len() > MAX_READY_LINE_BYTES {
                    return Err(SidecarError::InvalidReadyFrame);
                }
                let line =
                    std::str::from_utf8(&bytes).map_err(|_| SidecarError::InvalidReadyFrame)?;
                return parse_ready_server_line(line);
            }
            CommandEvent::Terminated(_) => return Err(SidecarError::ExitedBeforeReady),
            _ => {}
        }
    }
    Err(SidecarError::ExitedBeforeReady)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn spawn_plugin_child() -> (tauri::async_runtime::Receiver<CommandEvent>, CommandChild) {
        let app = mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app failed");
        app.shell()
            .command(std::env::current_exe().expect("test executable missing"))
            .args([
                "server_sidecar::tests::child_process_fixture",
                "--exact",
                "--ignored",
            ])
            .spawn()
            .expect("plugin child spawn failed")
    }

    async fn assert_child_terminated(events: &mut tauri::async_runtime::Receiver<CommandEvent>) {
        let terminated = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(event) = events.recv().await {
                if matches!(event, CommandEvent::Terminated(_)) {
                    return true;
                }
            }
            false
        })
        .await
        .expect("child termination timed out");
        assert!(terminated, "child event stream closed without termination");
    }

    #[test]
    #[ignore]
    fn child_process_fixture() {
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn accepts_the_versioned_loopback_ready_frame() {
        let ready = parse_ready_server_line(
            r#"{"kind":"einfach-agent-server-ready","version":1,"url":"http://127.0.0.1:3210/?token=secret"}"#,
        )
        .unwrap();
        assert_eq!(ready.url.port(), Some(3210));
    }

    #[test]
    fn rejects_wrong_kind_version_and_remote_urls() {
        for line in [
            r#"{"kind":"other","version":1,"url":"http://127.0.0.1:1"}"#,
            r#"{"kind":"einfach-agent-server-ready","version":2,"url":"http://127.0.0.1:1"}"#,
            r#"{"kind":"einfach-agent-server-ready","version":1,"url":"https://example.com/"}"#,
        ] {
            assert_eq!(
                parse_ready_server_line(line).unwrap_err(),
                SidecarError::InvalidReadyFrame
            );
        }
    }

    #[tokio::test]
    async fn timeout_terminates_the_real_child() {
        let (_sender, mut receiver) = tauri::async_runtime::channel(1);
        let (mut child_events, child) = spawn_plugin_child();
        let result = await_ready_with_child(&mut receiver, child, Duration::from_millis(1)).await;
        assert_eq!(result.err(), Some(SidecarError::ReadyTimeout));
        assert_child_terminated(&mut child_events).await;
    }

    #[tokio::test]
    async fn startup_failure_terminates_the_real_child() {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        drop(sender);
        let (mut child_events, child) = spawn_plugin_child();
        let result = await_ready_with_child(&mut receiver, child, Duration::from_secs(1)).await;
        assert_eq!(result.err(), Some(SidecarError::ExitedBeforeReady));
        assert_child_terminated(&mut child_events).await;
    }

    #[tokio::test]
    async fn window_creation_failure_terminates_the_real_child() {
        let (mut child_events, child) = spawn_plugin_child();
        let server = RunningServer {
            ready: parse_ready_server_line(
                r#"{"kind":"einfach-agent-server-ready","version":1,"url":"http://127.0.0.1:1"}"#,
            )
            .unwrap(),
            _child: ChildGuard::new(child),
        };
        let result = server.handoff_after(
            |_| Err::<(), _>("window failed"),
            |_| panic!("failed window must not hand off its child"),
        );
        assert_eq!(result, Err("window failed"));
        assert_child_terminated(&mut child_events).await;
    }

    #[test]
    fn invalid_frame_errors_do_not_disclose_tokens() {
        let token = "never-print-this-token";
        let line =
            format!(r#"{{"kind":"wrong","version":1,"url":"http://127.0.0.1/?token={token}"}}"#);
        let error = parse_ready_server_line(&line).unwrap_err().to_string();
        assert!(!error.contains(token));
        assert!(!format!("{error:?}").contains(token));
    }
}
